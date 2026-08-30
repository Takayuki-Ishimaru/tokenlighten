import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { callTool, normalizeCanonicalRequest } from "../server.js";
import { resetAll } from "../util/session.js";

// W2-5(b): `ALLOW_WRITE` (server.ts) is a module-level constant read from
// `process.argv` at import time — it cannot be flipped true for an in-process
// `callTool()` in this test process. Every edit-path spec in this suite that
// needs real writes spawns instead (see closureSatisfiedEditGate.spec.ts's
// header comment, and replayCorpus.spec.ts's many "spawned server,
// --allow-write" groups); this is the same minimal harness.
const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

interface WriteEnabledServerHandle {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
}

const writeEnabledServers: WriteEnabledServerHandle[] = [];

function startWriteEnabledServer(cwd: string): WriteEnabledServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, cwd, "--allow-write"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let stdoutBuf = "";
  let stderr = "";
  let nextId = 1;
  const waiters = new Map<number, (msg: any) => void>();

  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id)!;
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  function send(obj: unknown): void {
    child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 25000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  let ready: Promise<void> | undefined;
  async function ensureReady(): Promise<void> {
    if (ready === undefined) {
      ready = rpc(nextId++, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      }).then(() => {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
      });
    }
    return ready;
  }

  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      await ensureReady();
      const res = await rpc(nextId++, "tools/call", { name, arguments: args });
      const text: unknown = res?.result?.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error(`write-enabled spawn: tools/call '${name}' returned no text content: ${JSON.stringify(res)}`);
      }
      return JSON.parse(text) as Record<string, unknown>;
    },
    kill(): void {
      try { child.kill("SIGKILL"); } catch { /* ok */ }
    },
  };
}

const roots: string[] = [];

afterEach(() => {
  resetAll();
  // Kill any spawned write-enabled server BEFORE removing the workspace
  // directories below — several of them are that server's own `cwd`.
  for (const srv of writeEnabledServers.splice(0)) srv.kill();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// W2-5(a): same convention as replayCorpus.spec.ts (:71/:1671) — a HOME-based
// workspace, not `os.tmpdir()`. The root-mismatch forensics wave found guard
// logic that special-cases system temp roots; a workspace built under
// `os.tmpdir()` can silently take a different guard path than a real
// caller's repo (under HOME) would, which is exactly how `sameServe()` below
// went vacuous — both legacy and canonical calls refused identically for an
// environmental reason unrelated to D-3 routing, and the equality assertion
// passed without ever comparing two real serves.
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

function workspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-canonical-${tag}-`)));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "sample.ts"), "export const needle = 1;\nexport const second = needle + 1;\n");
  return root;
}

function body(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function stable(value: unknown, root: string): string {
  return JSON.stringify(value)
    .replaceAll(root, "<root>")
    .replace(/"handle":"h[0-9a-z]+"/g, "\"handle\":\"<handle>\"")
    .replace(/"sha":"sha256:[0-9a-f]+"/g, "\"sha\":\"<sha>\"");
}

async function sameServe(
  tool: "read_file" | "search_files",
  legacyArgs: Record<string, unknown>,
  canonicalArgs: Record<string, unknown>,
): Promise<void> {
  const root = workspace(tool);
  const legacy = body(await callTool(tool, { ...legacyArgs, cwd: root }));
  resetAll();
  const canonical = body(await callTool(tool, { ...canonicalArgs, cwd: root }));
  // W2-5(a) ANTI-VACUITY ASSERT: a `sameServe` call exists to prove the
  // canonical spelling reaches the SAME legacy serving path as the prose
  // spelling. Two calls that both refuse (e.g. both rejected for an
  // environmental reason unrelated to D-3 routing — a workspace guard, a
  // missing fixture file) can still be byte-identical after `stable()` and
  // pass the equality check below without ever exercising a real serve. Fail
  // loudly, before that check, rather than let a double-refusal read as
  // "routing verified".
  if (legacy["kind"] === "refusal" && canonical["kind"] === "refusal") {
    throw new Error(
      "sameServe: both the legacy and canonical calls refused — this proves nothing about D-3 routing "
      + `equivalence.\nlegacy: ${JSON.stringify(legacy)}\ncanonical: ${JSON.stringify(canonical)}`,
    );
  }
  expect(stable(canonical, root)).toBe(stable(legacy, root));
}

describe("D-3 canonical router serving equivalence", () => {
  it("routes canonical target ranges and defer through the legacy read serving paths", async () => {
    await sameServe(
      "read_file",
      { mode: "slice", path: "src/sample.ts", range: "1-2" },
      { targets: [{ path: "src/sample.ts", range: "1-2" }], content: "auto", task: { force_serve: true } },
    );
    await sameServe(
      "read_file",
      { mode: "small_file", path: "src/sample.ts" },
      { targets: [{ path: "src/sample.ts" }], content: "defer" },
    );
  });

  it("routes canonical search scope and budget through the existing search serving path", async () => {
    await sameServe(
      "search_files",
      { action: "find", queries: ["needle"], path: "src", limit: 4 },
      { action: "find", queries: ["needle"], scope: { path: "src", kind: "text" }, budget: { items: 4 } },
    );
  });

  it("normalizes legacy locate to the sole tree closure route", () => {
    expect(normalizeCanonicalRequest("search_files", {
      action: "locate", queries: ["calculatePremium"], scope: { path: "src" },
    })).toMatchObject({
      action: "tree",
      query: "calculatePremium",
      path: "src",
      includeClosure: true,
    });
  });

  it("maps the canonical task, budget, scope, credentials, and one-item intent homes", () => {
    expect(normalizeCanonicalRequest("edit_file", {
      task: { handle: "th1", force_serve: true },
      credentials: { in: "source", out: "destination" },
      edits: [{ path: "src/sample.ts", intent: { kind: "rename", from: "needle", to: "renamed" } }],
    })).toEqual({
      task_handle: "th1",
      force_serve: true,
      credentialRef: "source",
      outputCredentialRef: "destination",
      path: "src/sample.ts",
      mode: "rename",
      from: "needle",
      to: "renamed",
    });
    expect(normalizeCanonicalRequest("read_file", {
      targets: [{ path: "src/sample.ts", range: "1-1" }],
      budget: { bytes: 128, tokens: 32, items: 2, rows: 3, cells: 4, allowFull: true },
      scope: { includeClosure: true, surfaceRoles: ["code"] },
    })).toMatchObject({
      mode: "slice",
      path: "src/sample.ts",
      range: "1-1",
      maxBytes: 128,
      maxTokens: 32,
      limit: 2,
      maxRows: 3,
      maxCells: 4,
      allowFull: true,
      includeClosure: true,
      surfaceRoles: ["code"],
    });
    expect(normalizeCanonicalRequest("read_file", { task: { pull: "closure" } })).toEqual({ mode: "closure" });
  });
});

// W2-2: `mapCanonicalSelect`'s return value used to be "ANY select field is
// present", which routed a bare `select:{sections:[...]}` or
// `select:{comments:"keep"}` canonical call onto `mode="artifact"` — a
// reader that cannot answer either request (there is no recognized artifact
// `kind` for a plain source/markdown file). The fix narrows the mode=artifact
// trigger to ARTIFACT_SELECT_KEYS (kind/format/sheet/rows/columns/slides/
// pages); `comments` and `sections` still get copied onto `args` exactly as
// before, just without forcing artifact mode. These four probes are the
// review's own live-reproduction cases, fixed as regressions: the canonical
// spelling must reach the exact same legacy serving path as the equivalent
// prose call, for both fields, in both directions.
describe("W2-2 select routes comments/sections through ordinary read serving, not artifact", () => {
  function withMarkdownFixture(root: string): void {
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs", "readme.md"),
      "# Title\n\n## Intro\n\nHello there.\n\n## Details\n\nMore text.\n",
    );
  }

  it("select.comments (canonical) reaches the same serve as comments= (legacy)", async () => {
    await sameServe(
      "read_file",
      { path: "src/sample.ts", comments: "keep" },
      { targets: [{ path: "src/sample.ts" }], select: { comments: "keep" } },
    );
  });

  it("select.sections (canonical) reaches the same serve as sections= (legacy)", async () => {
    const root = workspace("w2-2-sections");
    withMarkdownFixture(root);
    const legacy = body(await callTool("read_file", { path: "docs/readme.md", sections: ["Intro"], cwd: root }));
    resetAll();
    const canonical = body(
      await callTool("read_file", { targets: [{ path: "docs/readme.md" }], select: { sections: ["Intro"] }, cwd: root }),
    );
    if (legacy["kind"] === "refusal" && canonical["kind"] === "refusal") {
      throw new Error(
        `sameServe: both the legacy and canonical calls refused.\nlegacy: ${JSON.stringify(legacy)}\ncanonical: ${JSON.stringify(canonical)}`,
      );
    }
    expect(stable(canonical, root)).toBe(stable(legacy, root));
    // Not vacuous in the OTHER direction too: prove this actually served the
    // section (not, say, two identically-shaped refusals for an unrelated
    // reason) by requiring a real evidence body naming the served section.
    expect(legacy["kind"]).toBe("read.text");
    const evidence = legacy["evidence"];
    expect(Array.isArray(evidence) && evidence.length > 0).toBe(true);
    const first = (evidence as Array<Record<string, unknown>>)[0]!;
    expect(typeof first["handle"]).toBe("string");
    expect(String(first["body"])).toContain("Hello there.");
  });

  it("neither select.comments nor select.sections alone is mistaken for mode=artifact (no recognized-artifact-kind refusal)", async () => {
    const root = workspace("w2-2-no-artifact");
    withMarkdownFixture(root);
    const commentsResult = body(
      await callTool("read_file", { targets: [{ path: "src/sample.ts" }], select: { comments: "keep" }, cwd: root }),
    );
    resetAll();
    const sectionsResult = body(
      await callTool("read_file", { targets: [{ path: "docs/readme.md" }], select: { sections: ["Intro"] }, cwd: root }),
    );
    for (const result of [commentsResult, sectionsResult]) {
      expect(result["kind"], JSON.stringify(result)).not.toBe("refusal");
    }
  });
});

describe("D-5 schema-valid canonical request property", () => {
  // W2-5(b): `code` ALONE cannot distinguish an argument-SHAPE refusal from
  // an operational one. Two different producers used to land in this same
  // set for reasons that had nothing to do with the shape of the call:
  //   - the well-established write-gate path returns the RECOGNIZED A.7.1
  //     code `write-not-enabled` (refusal.ts:235 lists it explicitly) —
  //     already a false positive for this property if ever hit in-process.
  //   - `create:true` specifically routes through createFile.ts, which used
  //     to spell its write-gate case `error: "write_disabled"` (underscore,
  //     uncoded) with no `code` at all; nothing mapped that spelling onto the
  //     recognized RefusalCode, so it fell through `refusalCodeOf`'s
  //     documented "unrecognized code -> coerce to invalid-input" fallback
  //     and surfaced as `{code:"invalid-input", detail:"write_disabled"}` —
  //     indistinguishable, by `code` alone, from a genuine argument-shape
  //     violation (confirmed live: this property FAILED on the `create:true`
  //     case below when run in-process against a real, HOME-based
  //     workspace, exactly because `code` collided).
  // RESOLVED in wave 3 (W3-4(c)): createFile.ts's write-gate branch now also
  // carries `code: "write-not-enabled"` alongside its existing `error`
  // string (createFile.spec.ts pins it directly), so both producers agree.
  // The property here is still made non-vacuous by exercising real writes
  // through a spawned server with `--allow-write` (ALLOW_WRITE is a
  // module-level constant read from argv at import time — see the harness
  // above), so neither write-gate producer fires and a genuine
  // argument-shape rejection is the only way `code` lands in this set.
  const argumentShapeCodes = new Set(["unknown-arguments", "invalid-input", "invalid-arguments", "argument-shape"]);

  it("accepts every canonical oneOf family without an argument-shape refusal", async () => {
    const root = workspace("schema-property");
    const readAndSearchCases: Array<["read_file" | "search_files", Record<string, unknown>]> = [
      ["read_file", { query: "sample export", task: { profile: "answer" } }],
      ["read_file", { targets: [{ path: "src/sample.ts" }], content: "full", select: { comments: "keep" } }],
      ["read_file", { query: "sample export", targets: [{ path: "src/sample.ts" }], scope: { includeClosure: true, surfaceRoles: ["code"] }, budget: { bytes: 512, tokens: 128, items: 2, rows: 2, cells: 2, allowFull: true } }],
      ["read_file", { task: { pull: "closure", force_serve: true } }],
      // RESOLVED in wave 3 (W3-4(b)): this row used to document a live find —
      // the full `budget:{bytes,tokens,items,rows,cells,allowFull}` shape was
      // schema-valid for search_files too (CANONICAL_BUDGET was one object
      // reused verbatim across all three tools) even though
      // `rows`/`cells`/`allowFull` are NOT in search_files's legacy dispatch
      // property list (there is no rows/cells/artifact concept in a search
      // result), so a caller following the ADVERTISED schema was refused
      // `unknown-arguments` for doing exactly what it advertised. Fixed by
      // splitting the shared object into CANONICAL_BUDGET (read_file, six
      // members) and CANONICAL_SEARCH_BUDGET (search_files,
      // bytes/tokens/items only) — the advertised search budget below is now
      // exactly what dispatch delivers, with no dispatch change needed.
      ["search_files", { action: "find", queries: ["needle"], scope: { path: "src", kind: "text", includeScores: true }, budget: { bytes: 512, tokens: 128, items: 2 } }],
      ["search_files", { action: "references", queries: ["needle"], scope: { path: "src", kind: "symbol" }, cursor: "not-a-valid-cursor" }],
      ["search_files", { action: "tree", scope: { path: "src", includeClosure: true, surfaceRoles: ["code"], depth: 1 } }],
    ];
    const editCases: Array<Record<string, unknown>> = [
      { edits: [{ path: "src/sample.ts", search: "needle", replace: "renamed" }], task: { force_serve: true } },
      { edits: [{ path: "src/new.ts", content: "export const made = 1;\n", create: true }], credentials: { in: "source", out: "destination" } },
    ];

    for (const [tool, args] of readAndSearchCases) {
      const result = body(await callTool(tool, { ...args, cwd: root }));
      expect(argumentShapeCodes.has(String(result["code"])), `${tool} canonical case rejected by shape: ${JSON.stringify(result)}`).toBe(false);
    }

    const writeSrv = startWriteEnabledServer(root);
    writeEnabledServers.push(writeSrv);
    for (const args of editCases) {
      const result = await writeSrv.callTool("edit_file", { ...args, cwd: root });
      expect(argumentShapeCodes.has(String(result["code"])), `edit_file canonical case rejected by shape: ${JSON.stringify(result)}`).toBe(false);
    }
  });

  it("keeps legacy find batches on their shared search carrier", () => {
    const legacy = { action: "find", queries: ["CW prop", "yaw torque"] };
    expect(normalizeCanonicalRequest("search_files", legacy)).toBe(legacy);
    expect(normalizeCanonicalRequest("search_files", {
      ...legacy,
      scope: { path: "src", kind: "text" },
    })).toEqual({ ...legacy, path: "src" });
    expect(normalizeCanonicalRequest("search_files", {
      action: "references",
      queries: ["needle"],
    })).toEqual({ action: "references", query: "needle" });
  });
});

// ---------------------------------------------------------------------------
// FX-2 (v0.13 wave-3 review fix): Claude Code 2.1.211 has been observed
// (review probe transcript) sending a canonical object/array top-level
// parameter JSON-STRINGIFIED (`typeof input.edits === "string"`) rather than
// as a native object/array — Codex CLI, sending native objects, does not hit
// this. Every consumer downstream of `normalizeCanonicalRequest` used to be
// silently string-blind: `task` in particular vanished with NO refusal at
// all (a strong suspected root cause of the repeated execution-typestate
// refusal loops this client was observed producing), while `edits` at least
// fell through to its own pre-existing "edits must be an array" refusal.
//
// D-5 acceptance-first: a string is rescued into its declared object/array
// shape ONLY when it parses as JSON AND the parsed value passes the exact
// same recursive property-name validation a native value would receive.
// ---------------------------------------------------------------------------
describe("FX-2 — string-to-structure leniency at the dispatch boundary (D-5 acceptance-first)", () => {
  it("rescues a JSON-stringified task AND a JSON-stringified edits[] together (the exact probe shape)", () => {
    expect(normalizeCanonicalRequest("edit_file", {
      task: JSON.stringify({ force_serve: true }),
      edits: JSON.stringify([{ path: "src/sample.ts", search: "needle", replace: "renamed" }]),
    })).toEqual({
      force_serve: true,
      edits: [{ path: "src/sample.ts", search: "needle", replace: "renamed" }],
    });
  });

  it("rescues a JSON-stringified item nested one level inside an otherwise-native edits[] array", () => {
    expect(normalizeCanonicalRequest("edit_file", {
      edits: [JSON.stringify({ path: "src/sample.ts", search: "needle", replace: "renamed" })],
    })).toEqual({
      edits: [{ path: "src/sample.ts", search: "needle", replace: "renamed" }],
    });
  });

  it("never reinterprets a queries[] item as structure — queries items are strings by design", () => {
    // A literal search for the text "[\"x\"]" must survive unchanged: queries'
    // declared item shape is a plain string, so the object-items-only nested
    // rescue must not even attempt it, regardless of what it would parse to.
    expect(normalizeCanonicalRequest("search_files", {
      action: "find",
      queries: ['["x"]'],
    })).toEqual({ action: "find", queries: ['["x"]'] });
  });

  it("leaves a non-candidate call byte-identical (no string anywhere in the rescued field set)", () => {
    const input = { action: "find", queries: ["needle"], scope: { path: "src" } };
    expect(normalizeCanonicalRequest("search_files", input)).toEqual({ action: "find", queries: ["needle"], path: "src" });
  });

  it("does not rescue a syntactically-invalid JSON string — falls back to the existing 'edits must be an array' refusal", async () => {
    const root = workspace("fx2-parse-fail");
    const writeSrv = startWriteEnabledServer(root);
    writeEnabledServers.push(writeSrv);
    const result = await writeSrv.callTool("edit_file", { edits: "[{path:1}]", cwd: root });
    expect(result["code"]).toBe("invalid-input");
    // Protocol v1 refusals carry no `error` field (A.5.15) — the prose rides
    // as `detail` instead (refusal.ts's `detailOf`).
    expect(String(result["detail"])).toContain("edits must be an array");
  });

  it("does not rescue a syntactically-valid but schema-invalid JSON string (unadvertised sub-property) — same existing refusal", async () => {
    const root = workspace("fx2-schema-fail");
    const writeSrv = startWriteEnabledServer(root);
    writeEnabledServers.push(writeSrv);
    const result = await writeSrv.callTool("edit_file", {
      edits: JSON.stringify([{ path: "src/sample.ts", search: "needle", replace: "renamed", bogusField: 1 }]),
      cwd: root,
    });
    expect(result["code"]).toBe("invalid-input");
    expect(String(result["detail"])).toContain("edits must be an array");
  });

  it("integration: stringified edits AND stringified task together still reach edit.applied end-to-end", async () => {
    const root = workspace("fx2-positive");
    const writeSrv = startWriteEnabledServer(root);
    writeEnabledServers.push(writeSrv);
    const result = await writeSrv.callTool("edit_file", {
      edits: JSON.stringify([
        { path: "src/sample.ts", search: "export const needle = 1;", replace: "export const needle = 42;" },
      ]),
      task: JSON.stringify({ force_serve: true }),
      cwd: root,
    });
    expect(result["kind"], JSON.stringify(result)).toBe("edit.applied");
    expect(fs.readFileSync(path.join(root, "src", "sample.ts"), "utf8")).toContain("needle = 42");
  });

  it("integration: the equivalent NATIVE (non-string) call reaches the identical edit.applied outcome (existing path unchanged)", async () => {
    const root = workspace("fx2-native-parity");
    const writeSrv = startWriteEnabledServer(root);
    writeEnabledServers.push(writeSrv);
    const result = await writeSrv.callTool("edit_file", {
      edits: [{ path: "src/sample.ts", search: "export const needle = 1;", replace: "export const needle = 42;" }],
      task: { force_serve: true },
      cwd: root,
    });
    expect(result["kind"], JSON.stringify(result)).toBe("edit.applied");
    expect(fs.readFileSync(path.join(root, "src", "sample.ts"), "utf8")).toContain("needle = 42");
  });
});
