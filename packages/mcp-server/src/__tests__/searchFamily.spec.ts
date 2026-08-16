/**
 * searchFamily.spec.ts — protocol v1, A.5.8–A.5.10 (C2-4).
 *
 * The exact regression call shapes for the `search_files` family migration:
 * `search.matches` (find / symbols / locate / diff under the `matches:{form}`
 * tag), `search.references` and `search.tree`. Plus the two rules C2-4 makes
 * binding beyond its own family:
 *
 *   - the CANONICAL LIMIT FOLD RULE (P3a advisory) — one `Limit` per response,
 *     priority `records` > `wire` > `time`, `source` never co-emitted with a
 *     delivery cause, and a `wire`/`records` limit with no nameable `next`
 *     degrades to `source` rather than promising a recovery it cannot deliver;
 *   - `Refusal`'s CLOSED ADVISORY ALLOWLIST and the conditional requirement of
 *     `certificate_id` on `retry:"challenge"` (user-adjudicated 2026-08-13).
 *
 * Wire-level throughout: every assertion reads what a client would receive, via
 * `callTool`, because the whole point of the migration is that the emitters keep
 * their in-process shapes and only the WIRE changes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { buildRefusal } from "../protocol/refusal.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

type Body = Record<string, unknown>;

function mkdir(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-sfam-${tag}-`)));
  tmpDirs.push(root);
  return root;
}

function write(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

async function call(args: Body): Promise<{ body: Body; isError: boolean }> {
  const result = await callTool("search_files", args);
  const text = result.content[0]?.text ?? "{}";
  return { body: JSON.parse(text) as Body, isError: (result as { isError?: boolean }).isError === true };
}

/** The `matches` sub-object, with its A.5.8 form tag asserted. */
function matchesOf(body: Body, form: string): Body {
  expect(body["kind"]).toBe("search.matches");
  const matches = body["matches"] as Body;
  expect(matches, JSON.stringify(body).slice(0, 300)).toBeDefined();
  expect(matches["form"]).toBe(form);
  return matches;
}

afterAll(() => {
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// A.5.8 `search.matches`
// ---------------------------------------------------------------------------

describe("A.5.8 search.matches — Rule K's `matches:{form}` tag and [R4-4] per-form addressing", () => {
  let root = "";

  beforeAll(() => {
    resetAllSessions();
    handleTable.reset();
    root = mkdir("matches");
    write(root, "package.json", '{"name":"sfam","type":"module"}\n');
    write(root, "src/orchestrator.ts", [
      "export type Order = { id: string; total: number };",
      "export class QuoteOrchestrator {",
      "  transition(state: string): string { return state.trim(); }",
      "}",
      "export function priceOrder(order: Order): number { return order.total; }",
    ].join("\n") + "\n");
    write(root, "src/ledger.ts", "export function postLedgerEntry(amount: number) {\n  return amount * 2;\n}\n");
  });

  it("find: fields move under `matches`, `query` is present, and a complete response carries NO limit", async () => {
    const { body } = await call({ cwd: root, action: "find", query: "priceOrder" });
    const matches = matchesOf(body, "find");

    // [R4-4]: `find` is the ONE form with a query, and it is required on it.
    expect(matches["query"]).toBe("priceOrder");
    expect(Array.isArray(matches["files"])).toBe(true);
    expect(typeof matches["total_files"]).toBe("number");
    expect(typeof matches["total_matches"]).toBe("number");
    expect(typeof matches["literal"]).toBe("boolean");

    // Rule K: nothing stayed at the top level beside the envelope.
    expect(body["files"]).toBeUndefined();
    expect(body["total_matches"]).toBeUndefined();
    // Rule T / E-4: absence of `limit` IS completeness.
    expect(body["limit"]).toBeUndefined();
    expect(matches["truncated"]).toBeUndefined();
  });

  it("find: a zero-hit response is VALID and COMPLETE — `absence`, no limit, no refusal", async () => {
    const { body, isError } = await call({ cwd: root, action: "find", query: "NOTHING_MATCHES_THIS_TOKEN" });
    expect(isError).toBe(false);
    const matches = matchesOf(body, "find");
    expect(matches["total_files"]).toBe(0);
    expect(matches["absence"]).toBeDefined();
    expect(body["limit"]).toBeUndefined();
  });

  it("symbols: `locations` + `total`, and NO fabricated `query` ([R4-4])", async () => {
    const { body } = await call({ cwd: root, action: "symbols", query: "priceOrder" });
    const matches = matchesOf(body, "symbols");
    expect(Array.isArray(matches["locations"])).toBe(true);
    expect(typeof matches["total"]).toBe("number");
    // The form that HAS no query never grows one to satisfy an envelope.
    expect(matches["query"]).toBeUndefined();
    expect(matches["truncated"]).toBeUndefined();
  });

  it("symbols: a path-only call is legitimate and keeps its explanatory `note`", async () => {
    const { body } = await call({ cwd: root, action: "symbols", path: "src/orchestrator.ts" });
    const matches = matchesOf(body, "symbols");
    expect(typeof matches["note"]).toBe("string");
    expect(matches["query"]).toBeUndefined();
  });

  it("locate: `{form:'locate', result}` carries LocateOutput unchanged, and a hit:false locate is NOT a refusal", async () => {
    const { body, isError } = await call({
      cwd: root, action: "locate", query: "a phrase that locates nothing at all",
    });
    expect(isError).toBe(false);
    const matches = matchesOf(body, "locate");
    const result = matches["result"] as Body;
    expect(result).toBeDefined();
    expect(typeof result["hit"]).toBe("boolean");
    // §4.3: a `hit:false` locate is a valid, COMPLETE result.
    expect(body["kind"]).toBe("search.matches");
  });
});

// ---------------------------------------------------------------------------
// A.9.2 rows 8 + 9 — `diff`
// ---------------------------------------------------------------------------

describe("A.5.8 `diff` — A.9.2 row 8 (total_files) and row 9 (error -> refusal)", () => {
  it("row 8: `totalFiles` is spelled `total_files` on the wire", async () => {
    const root = mkdir("diff-ok");
    write(root, "a.ts", "export const A = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
    fs.writeFileSync(path.join(root, "a.ts"), "export const A = 2;\n", "utf8");

    const { body } = await call({ cwd: root, action: "diff" });
    const matches = matchesOf(body, "diff");
    expect(typeof matches["total_files"]).toBe("number");
    expect(matches["totalFiles"]).toBeUndefined();
    expect(Array.isArray(matches["files"])).toBe(true);
    // [R4-4]: `diff` takes no query ARGUMENT and emits no query FIELD.
    expect(matches["query"]).toBeUndefined();
  });

  it("row 9: a failed `git diff` is a REFUSAL, not a success carrying an error string", async () => {
    // A repository with no commits: `git diff HEAD` fails on the revision, which
    // is the shape that produced §4.1's measured 7,576-byte response of which
    // ~7.4 KB was raw git usage text.
    const root = mkdir("diff-fail");
    write(root, "a.ts", "export const A = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: root });

    const { body, isError } = await call({ cwd: root, action: "diff" });
    expect(isError).toBe(true);
    expect(body["kind"]).toBe("refusal");
    expect(body["for"]).toBe("search_files");
    expect(body["code"]).toBe("read-error");
    expect(body["error"]).toBeUndefined();
    expect(body["matches"]).toBeUndefined();
    // A.8 E-7 + the 400-char `detail` cap is what bounds the git prose.
    expect(String(body["detail"] ?? "").length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// A.5.9 `search.references` — [R4-7] and A.9.2 row 19
// ---------------------------------------------------------------------------

describe("A.5.9 search.references — [R4-7] cursor placement and row 19's cause", () => {
  let root = "";

  beforeAll(() => {
    resetAllSessions();
    handleTable.reset();
    root = mkdir("refs");
    write(root, "package.json", '{"name":"refs","type":"module"}\n');
    for (let i = 0; i < 12; i++) {
      write(root, `src/mod${i}.ts`, [
        `import { contractTarget } from "./api.js";`,
        `export function use${i}() { return contractTarget(${i}); }`,
        `export function again${i}() { return contractTarget(${i} + 1); }`,
      ].join("\n") + "\n");
    }
    write(root, "src/api.ts", "export function contractTarget(n: number) { return n; }\n");
  });

  it("a complete page carries no limit; the bare truncation dialect is gone", async () => {
    const { body } = await call({ cwd: root, action: "references", query: "postLedgerEntryAbsent" });
    expect(body["kind"]).toBe("search.references");
    expect(typeof body["symbol"]).toBe("string");
    expect(Array.isArray(body["references"])).toBe(true);
    expect(Array.isArray(body["files"])).toBe(true);
    expect(typeof body["total"]).toBe("number");
    expect(body["truncated"]).toBeUndefined();
    expect(body["truncation_reason"]).toBeUndefined();
    expect(body["next_call"]).toBeUndefined();
    expect(body["limit"]).toBeUndefined();
  });

  it("[R4-7]: the opaque cursor rides INSIDE `limit.next.arguments.cursor` and nowhere else", async () => {
    const { body } = await call({ cwd: root, action: "references", query: "contractTarget", limit: 3 });
    expect(body["kind"]).toBe("search.references");

    const limit = body["limit"] as Body;
    expect(limit, JSON.stringify(body).slice(0, 400)).toBeDefined();
    // A.9.2 ROW 19, DECIDED: a record cap (with or without a co-occurring byte
    // fit) is `records` — the outer constraint, and the actionable one.
    expect(limit["cause"]).toBe("records");

    const next = limit["next"] as { tool: string; arguments: Body };
    expect(next).toBeDefined();
    expect(next.tool).toBe("search_files");
    expect(next.arguments["action"]).toBe("references");
    expect(typeof next.arguments["cursor"]).toBe("string");

    // §2.1.2 / A.8 E-6: there is NO standalone response-side cursor field.
    expect(body["cursor"]).toBeUndefined();
    expect(body["next_call"]).toBeUndefined();
    expect(body["files_omitted"]).toBeUndefined();
    expect(body["references_omitted"]).toBeUndefined();
  });

  it("the cursor still walks the chain to exhaustion when replayed verbatim", async () => {
    let page = (await call({ cwd: root, action: "references", query: "contractTarget", limit: 3 })).body;
    const seen = new Set<string>();
    let hops = 0;
    for (;;) {
      for (const group of page["files"] as Array<{ path: string; lines: number[] }>) {
        for (const line of group.lines) seen.add(`${group.path}#${line}`);
      }
      const limit = page["limit"] as Body | undefined;
      const next = limit?.["next"] as { arguments: Body } | undefined;
      if (next === undefined) break;
      expect(++hops).toBeLessThan(40);
      page = (await call({ cwd: root, ...next.arguments })).body;
    }
    expect(seen.size).toBe(page["total"]);
  });
});

// ---------------------------------------------------------------------------
// A.5.10 `search.tree` — D4 and A.9.2 row 10's third site
// ---------------------------------------------------------------------------

describe("A.5.10 search.tree — D4's stamp deletion and row 10's symlink-escape site", () => {
  let root = "";

  beforeAll(() => {
    resetAllSessions();
    root = mkdir("tree");
    write(root, "package.json", '{"name":"tree","type":"module"}\n');
    write(root, "src/a.ts", "export const A = 1;\n");
  });

  it("D4: the `mode:\"tree\"` stamp is deleted; `kind` is the sole discriminator", async () => {
    const { body } = await call({ cwd: root, action: "tree" });
    expect(body["kind"]).toBe("search.tree");
    expect(body["mode"]).toBeUndefined();
    expect(typeof body["root"]).toBe("string");
    expect(typeof body["tree"]).toBe("string");
    expect(typeof body["depth"]).toBe("number");
    expect(body["truncated"]).toBeUndefined();
    expect(body["limit"]).toBeUndefined();
  });

  it("row 10, THIRD SITE: the symlink-escape guard's `{refused:true}` is a REFUSAL, not an empty success", async () => {
    // The row cites only `buildCompactTree`'s two `{ok:false}` blocks. This one
    // sets `refused:true` and NO `ok:false`, so the generic funnel test could
    // not see it and it shipped as a successful, empty `search.tree`.
    const outside = mkdir("tree-escape-target");
    write(outside, "secret.ts", "export const SECRET = 1;\n");
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");

    const { body, isError } = await call({ cwd: root, action: "tree", path: "escape" });
    expect(isError).toBe(true);
    expect(body["kind"]).toBe("refusal");
    expect(body["code"]).toBe("path-outside-workspace");
    expect(body["refused"]).toBeUndefined();
    // D6: no empty success payload rides a refusal.
    expect(body["tree"]).toBeUndefined();
    expect(body["root"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The canonical limit fold rule (P3a advisory, binding for this family)
// ---------------------------------------------------------------------------

describe("CANONICAL LIMIT FOLD RULE — one Limit, records > wire > time, source promises nothing", () => {
  it("clause 1: a truncated find carries exactly ONE limit and no residual truncation dialect", async () => {
    const root = mkdir("fold-find");
    write(root, "package.json", '{"name":"fold","type":"module"}\n');
    for (let i = 0; i < 90; i++) {
      write(root, `src/deeply/nested/area${i}/component_with_a_long_name_${i}.ts`,
        `export const BIGNEEDLE_${i} = "BIGNEEDLE occurrence in a fairly long source line ${i}";\n`.repeat(3));
    }
    const { body } = await call({ cwd: root, action: "find", query: "BIGNEEDLE" });
    const matches = matchesOf(body, "find");

    const limit = body["limit"] as Body;
    expect(limit, JSON.stringify(body).slice(0, 300)).toBeDefined();
    // Exactly one carrier: no `truncated`, no per-response ledger beside it.
    expect(matches["truncated"]).toBeUndefined();
    expect(Object.keys(body).filter((k) => k === "limit")).toHaveLength(1);
    expect(limit["omitted"]).toEqual(["results"]);

    // Clause 2: the find cut is the byte budget, and `records` does not apply —
    // find has no result-count cap, only a response cap.
    expect(limit["cause"]).toBe("wire");
    // E-5: `wire` REQUIRES an executable `next`, and the one this response names
    // scopes the SAME query at a file it did NOT serve — not a re-issue of what
    // the caller already holds (the dead-end class §2.1.2 forbids).
    const next = limit["next"] as { tool: string; arguments: Body };
    expect(next.tool).toBe("search_files");
    expect(next.arguments["action"]).toBe("find");
    expect(next.arguments["query"]).toBe("BIGNEEDLE");
    const served = new Set((matches["files"] as Array<{ path: string }>).map((f) => f.path));
    expect(served.has(String(next.arguments["path"]))).toBe(false);
    expect((matches["inventory"] as unknown[]).length).toBeGreaterThan(served.size);
  });

  it("clause 4 + A.5.8: a truncated `symbols` names a SYNTHESISED larger-limit re-issue", async () => {
    const root = mkdir("fold-symbols");
    write(root, "package.json", '{"name":"fold","type":"module"}\n');
    for (let i = 0; i < 60; i++) {
      write(root, `src/probe${i}.ts`, `export function probeSymbol${i}() { return ${i}; }\n`);
    }

    const { body } = await call({ cwd: root, action: "symbols", query: "probeSymbol", limit: 4 });
    const matches = matchesOf(body, "symbols");
    const limit = body["limit"] as Body;
    expect(limit, JSON.stringify(body).slice(0, 300)).toBeDefined();
    // A record cap is the actionable cause and outranks the byte fit after it.
    expect(limit["cause"]).toBe("records");
    const next = limit["next"] as { tool: string; arguments: Body };
    expect(next.tool).toBe("search_files");
    expect(next.arguments["action"]).toBe("symbols");
    expect(next.arguments["query"]).toBe("probeSymbol");
    // The synthesis: an explicit limit equal to the TRUE total, so the re-issue
    // actually advances rather than repeating the same page.
    expect(next.arguments["limit"]).toBe(matches["total"]);
    expect(Number(next.arguments["limit"])).toBeGreaterThan(
      (matches["locations"] as unknown[]).length,
    );
  });
});

// ---------------------------------------------------------------------------
// §2.6 / A.5.15 — the closed advisory allowlist and `certificate_id`
// ---------------------------------------------------------------------------

describe("A.5.15 Refusal — the CLOSED advisory allowlist (user-adjudicated 2026-08-13)", () => {
  it("an ALLOWLISTED advisory field passes", () => {
    const refusal = buildRefusal("edit_file", {
      ok: false,
      code: "search-not-unique",
      hint: "narrow the search",
      candidates: [{ path: "src/a.ts", line: 3 }],
      expected_shapes: ["{search, replace}"],
      file_line_count: 42,
    }) as Record<string, unknown>;
    expect(refusal["hint"]).toBe("narrow the search");
    expect(refusal["candidates"]).toEqual([{ path: "src/a.ts", line: 3 }]);
    expect(refusal["expected_shapes"]).toEqual(["{search, replace}"]);
    expect(refusal["file_line_count"]).toBe(42);
  });

  it("a NON-enumerated field does NOT pass — the allowlist is closed, not a denylist", () => {
    const refusal = buildRefusal("read_file", {
      ok: false,
      code: "not-found",
      some_new_diagnostic: "invented by a future emitter",
      requested_handle: "h9zz",
      phase: "prepared",
    }) as Record<string, unknown>;
    expect(refusal["some_new_diagnostic"]).toBeUndefined();
    expect(refusal["requested_handle"]).toBeUndefined();
    expect(refusal["phase"]).toBeUndefined();
    expect(refusal["code"]).toBe("not-found");
  });

  it("the workspace disclosures are a DIFFERENT class and survive on a refusal", () => {
    // `root_note` answers "which tree answered?", not "how do I recover?" — the
    // 2026-08-09 root-mismatch wave stamps it on write-path refusals precisely
    // because that is when the question is load-bearing.
    const refusal = buildRefusal("edit_file", {
      ok: false, code: "not-found", root_note: "resolved against <default> — you named no cwd",
    }) as Record<string, unknown>;
    expect(refusal["root_note"]).toBe("resolved against <default> — you named no cwd");
  });

  it("A.9.2 rows 5 + 6: the prose `terminal_reason` becomes `detail`, and the machine token riding `error` does not", () => {
    const refusal = buildRefusal("search_files", {
      ok: false,
      error: "find-all-served-repeat",
      reason: "repeated-all-served-find",
      terminal: true,
      terminal_reason: "every file this query matches was already served to you this session",
      required_action: "unlock-or-rescope",
    }) as Record<string, unknown>;
    expect(refusal["code"]).toBe("repeated-all-served-find");
    expect(refusal["detail"]).toBe(
      "every file this query matches was already served to you this session",
    );
    expect(String(refusal["detail"])).not.toContain("find-all-served-repeat");
    expect(refusal["error"]).toBeUndefined();
    expect(refusal["terminal"]).toBeUndefined();
    expect(refusal["terminal_reason"]).toBeUndefined();
    expect(refusal["required_action"]).toBeUndefined();
  });
});

describe("A.5.15 Refusal — `certificate_id` is CONDITIONALLY REQUIRED on retry:\"challenge\"", () => {
  const challengeBody = {
    ok: false,
    code: "execution-typestate",
    unlock: { accepted_transitions: ["challenge", "taskEpoch:new"] },
  };

  it("challenge + certificate_id: the transition stands and the id is on the wire", () => {
    const refusal = buildRefusal("read_file", {
      ...challengeBody, certificate_id: "cert-abc123",
    }) as Record<string, unknown>;
    expect(refusal["retry"]).toBe("challenge");
    expect(refusal["certificate_id"]).toBe("cert-abc123");
  });

  it("challenge WITHOUT certificate_id degrades to \"new-task\" — never an unauthorable challenge", () => {
    const refusal = buildRefusal("read_file", { ...challengeBody }) as Record<string, unknown>;
    expect(refusal["retry"]).toBe("new-task");
    expect(refusal["certificate_id"]).toBeUndefined();
  });

  it("a non-challenge refusal MAY still carry the id as provenance", () => {
    const refusal = buildRefusal("read_file", {
      ok: false, code: "prepared-discovery-closed", terminal: true, certificate_id: "cert-xyz",
    }) as Record<string, unknown>;
    expect(refusal["retry"]).toBe("none");
    expect(refusal["certificate_id"]).toBe("cert-xyz");
  });
});
