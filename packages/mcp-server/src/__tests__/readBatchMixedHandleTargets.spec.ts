// readBatchMixedHandleTargets.spec.ts — FX-M1/E1 (= INV-C F4 / INV-E E1).
//
// A `read_file targets:[...]` batch that MIXES a bare `{handle}` target (no
// `path`) with a `{path}` target used to silently lose the handle-only
// target: `server.ts`'s canonical->legacy request projection
// (`normalizeCanonicalRequest`) only preserves handles when the WHOLE batch
// is homogeneous (`targets.every(t => typeof t.handle === "string")`); the
// moment one target carries a bare `path` instead, EVERY target — including
// the handle-only one — gets routed through `legacyPathTarget`, which had no
// `handle` case at all and collapsed `{handle}` to `{}`. Depending on
// whether `content` was set at the call's top level, that `{}` either:
//   - (content:"full"/"outline") rode into the legacy mode=full/mode=skeleton
//     `paths[]` batch loops, which coerced it to `path:""` and silently
//     dropped it via their own "path is required" `omitted` gate, with the
//     rest of the batch reporting a well-formed-looking `read.batch` and NO
//     disclosure that a whole target vanished; or
//   - (content unset) fell through to task_pack discovery, where the same
//     empty-path entry surfaced as a literal internal wire-dialect string,
//     `missing:["(invalid paths[] entry: missing path)"]` — visibly wrong,
//     but naming OUR implementation detail (`paths[]`) rather than the
//     caller's own `handle`.
//
// The fix threads the handle through `legacyPathTarget` (server.ts) instead
// of dropping it, resolves it via `handleTable` at the point each consumer
// (the mode=full/mode=skeleton `paths[]` loops, and task_pack's own
// `normalizePathEntry`) actually knows the call's resolved workspace, and
// reports an unresolvable handle by name — never as a legacy `paths[]`
// string, never as a silent drop.
//
// Verified by temporarily reverting the server.ts/readCodeTaskPack.ts fix
// (git stash of this changeset) and re-running this file: every "no silent
// drop" assertion below failed before the fix (the handle-only target either
// vanished from `entries` entirely or the response degraded to
// `read.task_pack` with the literal `paths[]` string), and passes after it.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { resetAll } from "../state/session.js";
import { handleTable } from "../util/handles.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-mixed-batch-${tag}-`)));
  dirs.push(d);
  return d;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function parse(res: { content: Array<{ text: string }>; isError?: boolean }): {
  body: Record<string, unknown>;
  isError: boolean;
} {
  const text = res.content[0]?.text ?? "";
  return { body: JSON.parse(text) as Record<string, unknown>, isError: res.isError === true };
}

/** Mints a real, round-trippable handle for `relPath` via an ordinary full read. */
async function mintHandle(ws: string, relPath: string): Promise<string> {
  const res = parse(await callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd: ws }));
  expect(res.isError, JSON.stringify(res.body)).toBe(false);
  const entries = res.body["entries"] as Array<Record<string, unknown>> | undefined;
  const handle = entries !== undefined
    ? (entries[0]?.["handle"] as string | undefined)
    : (res.body["handle"] as string | undefined) ?? ((res.body["evidence"] as Array<Record<string, unknown>> | undefined)?.[0]?.["handle"] as string | undefined);
  expect(typeof handle, `expected a minted handle, got ${JSON.stringify(res.body)}`).toBe("string");
  return handle as string;
}

afterEach(() => {
  handleTable.reset();
  resetAll();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("FX-M1/E1: mixed targets:[{handle},{path}] read_file batch — content:\"full\"", () => {
  it("both targets are served — the handle-only target is never silently dropped", async () => {
    const ws = mkWs("full-both-served");
    write(ws, "src/big.ts", "export function big() {\n  return 1;\n}\n");
    write(ws, "src/other.ts", "export function other() {\n  return 2;\n}\n");
    const bigHandle = await mintHandle(ws, "src/big.ts");

    const res = parse(await callTool("read_file", {
      targets: [{ handle: bigHandle }, { path: "src/other.ts" }],
      content: "full",
      cwd: ws,
    }));

    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    expect(res.body["kind"]).toBe("read.batch");
    const items = (res.body["entries"] ?? res.body["items"]) as Array<Record<string, unknown>>;
    expect(Array.isArray(items), JSON.stringify(res.body)).toBe(true);
    const paths = items.map((it) => it["path"]);
    expect(paths, JSON.stringify(res.body)).toContain("src/big.ts");
    expect(paths, JSON.stringify(res.body)).toContain("src/other.ts");
    // Real content for BOTH — not an empty/omitted stand-in.
    const bigItem = items.find((it) => it["path"] === "src/big.ts");
    const otherItem = items.find((it) => it["path"] === "src/other.ts");
    expect(String(bigItem?.["content"] ?? "")).toContain("function big");
    expect(String(otherItem?.["content"] ?? "")).toContain("function other");
    // No hidden omission the caller can't see: whatever `omitted`/`limit`
    // arrived, it must not name either of the two real targets as dropped.
    const omitted = (res.body["omitted"] as unknown[] | undefined) ?? [];
    expect(omitted.length, JSON.stringify(res.body)).toBe(0);
  });

  it("order does not matter — handle second, path first", async () => {
    const ws = mkWs("full-order-independent");
    write(ws, "src/big.ts", "export function big() {\n  return 1;\n}\n");
    write(ws, "src/other.ts", "export function other() {\n  return 2;\n}\n");
    const bigHandle = await mintHandle(ws, "src/big.ts");

    const res = parse(await callTool("read_file", {
      targets: [{ path: "src/other.ts" }, { handle: bigHandle }],
      content: "full",
      cwd: ws,
    }));

    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    const items = (res.body["entries"] ?? res.body["items"]) as Array<Record<string, unknown>>;
    const paths = items.map((it) => it["path"]);
    expect(paths).toContain("src/big.ts");
    expect(paths).toContain("src/other.ts");
  });

  it("generalizes to 2 handles + 1 path in a single batch", async () => {
    const ws = mkWs("full-two-handles");
    write(ws, "src/a.ts", "export const A = 1;\n");
    write(ws, "src/b.ts", "export const B = 2;\n");
    write(ws, "src/c.ts", "export const C = 3;\n");
    const aHandle = await mintHandle(ws, "src/a.ts");
    const bHandle = await mintHandle(ws, "src/b.ts");

    const res = parse(await callTool("read_file", {
      targets: [{ handle: aHandle }, { handle: bHandle }, { path: "src/c.ts" }],
      content: "full",
      cwd: ws,
    }));

    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    const items = (res.body["entries"] ?? res.body["items"]) as Array<Record<string, unknown>>;
    const paths = items.map((it) => it["path"]);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths).toContain("src/c.ts");
  });
});

describe("FX-M1/E1: mixed targets:[{handle},{path}] read_file batch — content:\"outline\"", () => {
  it("both targets are served as skeletons — the handle-only target is never silently dropped", async () => {
    const ws = mkWs("outline-both-served");
    write(ws, "src/big.ts", "export function bigFn() {\n  return 1;\n}\n");
    write(ws, "src/other.ts", "export function otherFn() {\n  return 2;\n}\n");
    const bigHandle = await mintHandle(ws, "src/big.ts");

    const res = parse(await callTool("read_file", {
      targets: [{ handle: bigHandle }, { path: "src/other.ts" }],
      content: "outline",
      cwd: ws,
    }));

    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    const items = (res.body["entries"] ?? res.body["items"]) as Array<Record<string, unknown>>;
    const paths = items.map((it) => it["path"]);
    expect(paths, JSON.stringify(res.body)).toContain("src/big.ts");
    expect(paths, JSON.stringify(res.body)).toContain("src/other.ts");
  });
});

describe("FX-M1/E1: an unresolvable handle in a mixed batch is disclosed, never dropped or leaked as legacy paths[]", () => {
  it("an unknown handle is reported (not silently dropped); the real path sibling still succeeds", async () => {
    const ws = mkWs("unknown-handle");
    write(ws, "src/other.ts", "export function other() {\n  return 2;\n}\n");

    const res = parse(await callTool("read_file", {
      targets: [{ handle: "hdoesnotexist000" }, { path: "src/other.ts" }],
      content: "full",
      cwd: ws,
    }));

    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    const items = (res.body["entries"] ?? res.body["items"]) as Array<Record<string, unknown>>;
    const paths = items.map((it) => it["path"]);
    // The real, resolvable sibling target is unaffected by its neighbor's
    // unresolvable handle — batching one bad reference must not sink the rest.
    expect(paths, JSON.stringify(res.body)).toContain("src/other.ts");
    expect(items.length, JSON.stringify(res.body)).toBe(1);

    // protocol/readFamily.ts's own documented Rule-T contract (`limitFrom`,
    // population 2: "A REFERENCE RESOLVED TO NOTHING... The measured case is
    // a `handles:[...]` batch carrying an unknown handle: the server never
    // learned a path for it, so there is nothing to reach... That stays
    // `source`") is the EXISTING disclosure shape this fix routes an
    // unresolvable handle-only target through — a non-empty `limit` proves
    // the server recorded that something was withheld, which is the
    // observable difference from the pre-fix silent vanish (zero entries,
    // zero `omitted`, zero `limit`, no trace the target was ever requested).
    const limit = res.body["limit"] as Record<string, unknown> | undefined;
    expect(limit, `a withheld reference must carry a limit, never silent loss: ${JSON.stringify(res.body)}`).toBeDefined();
    expect(limit?.["cause"]).toBe("source");
    expect(Array.isArray(limit?.["omitted"]) && (limit!["omitted"] as unknown[]).length > 0, JSON.stringify(res.body)).toBe(true);

    // AGENTS.md: "never emit legacy input" — the internal `paths[]` wire
    // dialect name must never leak onto the wire for a caller who only ever
    // used canonical `targets:[{handle}]`.
    const wholeText = JSON.stringify(res.body);
    expect(wholeText).not.toContain("invalid paths[] entry");
  });
});

describe("FX-M1/E1: mixed handle+path batch with no explicit `content` (mode-unspecified task_pack fallthrough)", () => {
  it("still resolves the handle instead of leaking a literal legacy paths[] string", async () => {
    const ws = mkWs("no-content-fallthrough");
    write(ws, "src/big.ts", "export function bigFn() {\n  return 1;\n}\n");
    write(ws, "src/other.ts", "export function otherFn() {\n  return 2;\n}\n");
    const bigHandle = await mintHandle(ws, "src/big.ts");

    const res = parse(await callTool("read_file", {
      targets: [{ handle: bigHandle }, { path: "src/other.ts" }],
      cwd: ws,
      task: { epoch: "new" },
    }));

    const wholeText = JSON.stringify(res.body);
    // Whatever kind this settles on (read.batch or read.task_pack), the
    // literal internal implementation-detail string must never appear.
    expect(wholeText).not.toContain("invalid paths[] entry: missing path");
  });
});
