/**
 * treePagingBudget1010.spec.ts — TPB (2026-10-10 independent runtime review):
 * `tl_search_files action:"tree"` honours `budget.bytes`, and a truncated tree
 * carries an executable `next` that serves the REST of the listing.
 *
 * THE MEASURED DEFECT (develop 07627077, before this fix). 30 directories of
 * 10 files (`src/module_NNN/file_NNN.ts`), `{action:"tree"}` at the default
 * depth 2 (a 331-line, ~5.3 KB listing):
 *
 *   no budget                       2,555 B  limit {cause:"capped"}, no next
 *   budget {bytes:4000|16000|64000} 2,555 B  the same capped page, no next
 *   budget {bytes:2000}             1,625 B  next = a SHALLOWER tree (depth 1),
 *                                            not the rest of this one
 *   budget {bytes:1000}               800 B  the same shallower-tree next
 *   depth 1, budget {bytes:1000}    refusal{cap-exceeded}, no next
 *
 * ROOT CAUSE. `buildCompactTree` cut the rendered listing at TREE_CAP_BYTES
 * (2048 B of text) whatever the caller declared, and `projectTree` folded the
 * cut into `capped` because no continuation could name the remainder without
 * choosing a subtree; below the default page the wire ladder's tree rung
 * halved the text and named `depth - 1`, and at depth 1 it declined.
 *
 * THE FIX (`tools/exploreTree.ts`'s TPB section): one listing, paged. With no
 * declared budget the page is the legacy 2048 B of text; with
 * `budget.bytes`/`budget.tokens` it is as many whole lines as keep the
 * response within the tighter of the two and the `search.tree` wire row
 * (8192 B). A page that stops short carries `limit:{cause:"wire",next}` — the
 * same scope and budget plus a signed cursor bound to the root, the depth and
 * a digest of the whole listing; a changed listing is refused `cursor-stale`
 * with the restart call as its `next`.
 *
 * Every case drives a REAL stdio server (`startDevServer`) and follows each
 * response's own `next` verbatim, exactly as AGENTS.md instructs a caller to.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { extractNext, startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { TREE_CAP_BYTES } from "../tools/exploreTree.js";
import { budgetFor } from "../protocol/budget/wireBudget.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const TREE_ROW_BYTES = budgetFor("search.tree");
const MARKER = "\n… (truncated)";

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});

afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function freshWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-tpb1010-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** The review's fixture: 30 directories of 10 files under `src/`. */
function writeModules(ws: string): void {
  for (let d = 0; d < 30; d++) {
    for (let f = 0; f < 10; f++) {
      writeFile(ws, `src/module_${String(d).padStart(3, "0")}/file_${String(f).padStart(3, "0")}.ts`, `export const v = ${f};\n`);
    }
  }
}

async function serverFor(ws: string): Promise<ServerHandle> {
  const server = startDevServer(ws, "default");
  servers.push(server);
  await server.initialize();
  return server;
}

/** The rendered listing at `depth`, as one string — what every chain must concatenate to. */
function expectedListing(depth: number): string {
  const lines: string[] = ["src/"];
  for (let d = 0; d < 30; d++) {
    const dir = `module_${String(d).padStart(3, "0")}`;
    if (depth <= 1) {
      lines.push(`  ${dir}/ (10 files)`);
      continue;
    }
    lines.push(`  ${dir}/`);
    for (let f = 0; f < 10; f++) lines.push(`    file_${String(f).padStart(3, "0")}.ts`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Chain walking
// ---------------------------------------------------------------------------

interface Page {
  body: Record<string, unknown>;
  textBytes: number;
}

interface Chain {
  pages: Page[];
  capped: boolean;
}

async function walkTree(server: ServerHandle, args: Record<string, unknown>, hopCap = 60): Promise<Chain> {
  const pages: Page[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } | undefined = { tool: "tl_search_files", arguments: args };
  while (call !== undefined) {
    if (pages.length >= hopCap) break;
    const { body, textBytes } = await server.callTool(call.tool, call.arguments);
    pages.push({ body: body as Record<string, unknown>, textBytes });
    call = extractNext(body).next;
  }
  return { pages, capped: call !== undefined };
}

function describeChain(chain: Chain): string {
  return `calls=${chain.pages.length} pages=[${chain.pages
    .map((page) => `${page.textBytes}B/${String(page.body["kind"])}/${String((page.body["limit"] as Record<string, unknown> | undefined)?.["cause"] ?? "-")}`)
    .join(" ")}]`;
}

/** The listing a chain delivered: every page's `tree`, its truncation marker removed. */
function concatenated(chain: Chain): string {
  return chain.pages
    .map((page) => {
      const tree = String(page.body["tree"] ?? "");
      return tree.endsWith(MARKER) ? tree.slice(0, -MARKER.length) : tree;
    })
    .join("\n");
}

/**
 * The chain completed without a refusal, delivered exactly `listing` (every
 * line once, in order), every page but the last said `limit:{cause:"wire"}`
 * with a cursor continuation of the SAME tree, and only the last page is
 * complete.
 */
function expectWholeListing(chain: Chain, listing: string, scope: { path: string; depth: number }, budget?: Record<string, unknown>): void {
  const refusals = chain.pages.filter((page) => page.body["kind"] === "refusal");
  expect(refusals.map((page) => JSON.stringify(page.body).slice(0, 400))).toEqual([]);
  expect(chain.capped, `chain never completed: ${describeChain(chain)}`).toBe(false);
  expect(concatenated(chain), describeChain(chain)).toBe(listing);
  chain.pages.forEach((page, index) => {
    expect(page.body["kind"]).toBe("search.tree");
    const report = page.body["scope_report"] as Record<string, unknown>;
    const last = index === chain.pages.length - 1;
    if (last) {
      expect(page.body["limit"], "the last page carries no limit").toBeUndefined();
      expect(report["completeness"]).toBe("complete");
      expect(String(page.body["tree"])).not.toContain(MARKER);
      return;
    }
    const limit = page.body["limit"] as Record<string, unknown>;
    expect(limit["cause"], JSON.stringify(limit)).toBe("wire");
    expect(limit["omitted"]).toEqual(["results"]);
    expect(report["completeness"]).toBe("partial");
    expect(String(page.body["tree"]).endsWith(MARKER)).toBe(true);
    const next = extractNext(page.body).next!;
    expect(next.tool).toBe("tl_search_files");
    expect(next.arguments["action"]).toBe("tree");
    expect(next.arguments["scope"]).toEqual(scope);
    expect(typeof next.arguments["cursor"]).toBe("string");
    expect(next.arguments["budget"]).toEqual(budget);
  });
}

// ---------------------------------------------------------------------------
// 1. The review's observations, one by one.
// ---------------------------------------------------------------------------

describe("TPB: the review's tree calls — every truncated page now names the rest of the listing", () => {
  it("no budget: the default page is unchanged in size, and its next pages through the whole listing", async () => {
    const ws = freshWorkspace("default");
    writeModules(ws);
    const server = await serverFor(ws);
    const chain = await walkTree(server, { action: "tree", cwd: ws });
    // Was: one 2,555 B page, `capped`, no next. Measured after: 3 pages
    // (~2.9 KB, ~2.9 KB, ~1.5 KB).
    expectWholeListing(chain, expectedListing(2), { path: ".", depth: 2 });
    for (const page of chain.pages) {
      const tree = String(page.body["tree"]);
      const text = tree.endsWith(MARKER) ? tree.slice(0, -MARKER.length) : tree;
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(TREE_CAP_BYTES);
    }
    expect(chain.pages.length).toBe(3);
  }, 60_000);

  for (const bytes of [4000, 16000, 64000]) {
    it(`budget {bytes:${bytes}}: a bigger budget is a bigger page, never past it or the ${TREE_ROW_BYTES} B row`, async () => {
      const ws = freshWorkspace(`big${bytes}`);
      writeModules(ws);
      const server = await serverFor(ws);
      const chain = await walkTree(server, { action: "tree", cwd: ws, budget: { bytes } });
      // Was: the same 2,555 B capped page at every one of these budgets.
      expectWholeListing(chain, expectedListing(2), { path: ".", depth: 2 }, { bytes });
      const ceiling = Math.min(bytes, TREE_ROW_BYTES);
      for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(ceiling);
      // The 331-line listing is one ~6.3 KB response: one call within the
      // row, two at 4000 B (the first filled to the budget).
      if (ceiling >= 7000) {
        expect(chain.pages.length, describeChain(chain)).toBe(1);
      } else {
        expect(chain.pages.length, describeChain(chain)).toBe(2);
        expect(chain.pages[0]!.textBytes, describeChain(chain)).toBeGreaterThanOrEqual(0.9 * ceiling);
      }
    }, 60_000);
  }

  for (const bytes of [1000, 2000]) {
    it(`budget {bytes:${bytes}}: every page within it, and next is the rest of THIS tree (not a shallower one)`, async () => {
      const ws = freshWorkspace(`small${bytes}`);
      writeModules(ws);
      const server = await serverFor(ws);
      const chain = await walkTree(server, { action: "tree", cwd: ws, budget: { bytes } });
      expectWholeListing(chain, expectedListing(2), { path: ".", depth: 2 }, { bytes });
      for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(bytes);
      for (const page of chain.pages.slice(0, -1)) {
        expect(page.textBytes, describeChain(chain)).toBeGreaterThanOrEqual(0.85 * bytes);
        expect(page.body["depth"]).toBe(2);
      }
    }, 60_000);
  }

  it("depth 1, budget {bytes:1000}: was refusal{cap-exceeded} with no next — now paged within the budget", async () => {
    const ws = freshWorkspace("depth1");
    writeModules(ws);
    const server = await serverFor(ws);
    const chain = await walkTree(server, { action: "tree", cwd: ws, scope: { depth: 1 }, budget: { bytes: 1000 } });
    expectWholeListing(chain, expectedListing(1), { path: ".", depth: 1 }, { bytes: 1000 });
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(1000);
    expect(chain.pages.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("budget {tokens:400} binds like the 1600 B it converts to, and is echoed as declared", async () => {
    const ws = freshWorkspace("tokens");
    writeModules(ws);
    const server = await serverFor(ws);
    const chain = await walkTree(server, { action: "tree", cwd: ws, budget: { tokens: 400 } });
    expectWholeListing(chain, expectedListing(2), { path: ".", depth: 2 }, { tokens: 400 });
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(1600);
  }, 60_000);

  it("a listing whose FINISHED response fits the budget is one page, though no continuation would fit beside it", async () => {
    const ws = freshWorkspace("boundary");
    writeModules(ws);
    const server = await serverFor(ws);
    const whole = await walkTree(server, { action: "tree", cwd: ws, budget: { bytes: 16000 } });
    expect(whole.pages.length, describeChain(whole)).toBe(1);
    const size = whole.pages[0]!.textBytes;
    // 96 = the 64 B page-envelope safety margin (exploreTree.ts) plus slack.
    for (const bytes of [size + 96, size + 300]) {
      const chain = await walkTree(server, { action: "tree", cwd: ws, budget: { bytes } });
      expect(chain.pages.length, `budget ${bytes} (finished page ${size} B): ${describeChain(chain)}`).toBe(1);
      expect(chain.pages[0]!.textBytes).toBe(size);
      expect(chain.pages[0]!.body["tree"]).toBe(expectedListing(2));
    }
    const under = await walkTree(server, { action: "tree", cwd: ws, budget: { bytes: size - 1 } });
    expectWholeListing(under, expectedListing(2), { path: ".", depth: 2 }, { bytes: size - 1 });
    expect(under.pages.length).toBeGreaterThanOrEqual(2);
    for (const page of under.pages) expect(page.textBytes, describeChain(under)).toBeLessThanOrEqual(size - 1);
  }, 60_000);

  it("a listing that fits is one complete page: no limit, no next", async () => {
    const ws = freshWorkspace("fits");
    writeModules(ws);
    const server = await serverFor(ws);
    const { body } = await server.callTool("tl_search_files", { action: "tree", cwd: ws, scope: { depth: 1 }, budget: { bytes: 16000 } });
    expect(body["kind"]).toBe("search.tree");
    expect(body["limit"]).toBeUndefined();
    expect(extractNext(body).next).toBeUndefined();
    expect(body["tree"]).toBe(expectedListing(1));
    expect((body["scope_report"] as Record<string, unknown>)["completeness"]).toBe("complete");
  }, 60_000);

  it("a subdirectory root pages the same way, its scope echoed on every continuation", async () => {
    const ws = freshWorkspace("subdir");
    for (let f = 0; f < 120; f++) writeFile(ws, `pkg/deep/file_${String(f).padStart(3, "0")}.ts`, "export {};\n");
    const server = await serverFor(ws);
    const chain = await walkTree(server, { action: "tree", cwd: ws, scope: { path: "pkg/deep" }, budget: { bytes: 1200 } });
    const listing = Array.from({ length: 120 }, (_, f) => `file_${String(f).padStart(3, "0")}.ts`).join("\n");
    expectWholeListing(chain, listing, { path: "pkg/deep", depth: 2 }, { bytes: 1200 });
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(1200);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Budgets across depths: never a page over budget, never a line lost.
// ---------------------------------------------------------------------------

describe("TPB: every budget, every depth — every page within budget, the whole listing exactly once", () => {
  it("depths 1-3 x budgets 1000..8192: concatenation equals the listing, no page over its budget", async () => {
    const ws = freshWorkspace("sweep");
    // Nested, non-ASCII and quote-free names: depth 3 expands one level more.
    for (let d = 0; d < 12; d++) {
      for (let f = 0; f < 9; f++) {
        writeFile(ws, `src/m${String(d).padStart(2, "0")}/s_${f % 3}/f_${f}_ünï.ts`, "export {};\n");
      }
    }
    const server = await serverFor(ws);
    for (const depth of [1, 2, 3]) {
      const reference = concatenated(await walkTree(server, { action: "tree", cwd: ws, scope: { depth } }));
      for (const bytes of [1000, 1300, 2000, 3500, 8192]) {
        const chain = await walkTree(server, { action: "tree", cwd: ws, scope: { depth }, budget: { bytes } }, 120);
        expectWholeListing(chain, reference, { path: ".", depth }, { bytes });
        for (const page of chain.pages) {
          expect(page.textBytes, `depth ${depth} budget ${bytes}: ${describeChain(chain)}`).toBeLessThanOrEqual(bytes);
        }
      }
    }
  }, 180_000);

  it("a budget below one line plus its envelope is refused with a floor that carries the whole chain", async () => {
    const ws = freshWorkspace("floor");
    writeModules(ws);
    const server = await serverFor(ws);
    const first = (await server.callTool("tl_search_files", { action: "tree", cwd: ws, scope: { depth: 1 }, budget: { bytes: 500 } })).body as Record<string, unknown>;
    expect(first["kind"], JSON.stringify(first)).toBe("refusal");
    expect(first["code"]).toBe("budget-below-minimum");
    expect(first["field"]).toBe("budget");
    const floor = first["required_min_bytes"];
    expect(typeof floor === "number" && floor > 500 && floor < 1000, JSON.stringify(first)).toBe(true);
    const chain = await walkTree(server, { action: "tree", cwd: ws, scope: { depth: 1 }, budget: { bytes: floor } }, 60);
    expectWholeListing(chain, expectedListing(1), { path: ".", depth: 1 }, { bytes: floor });
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(floor as number);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. The cursor: bound to its listing, refused honestly when misused.
// ---------------------------------------------------------------------------

describe("TPB: the tree cursor", () => {
  async function firstPage(server: ServerHandle, ws: string): Promise<{ body: Record<string, unknown>; next: { tool: string; arguments: Record<string, unknown> } }> {
    const { body } = await server.callTool("tl_search_files", { action: "tree", cwd: ws, budget: { bytes: 1500 } });
    const next = extractNext(body).next;
    expect(next, JSON.stringify(body).slice(0, 400)).toBeDefined();
    return { body: body as Record<string, unknown>, next: next! };
  }

  it("a listing that changed under the cursor is refused cursor-stale, and its restart next serves the new listing", async () => {
    const ws = freshWorkspace("stale");
    writeModules(ws);
    const server = await serverFor(ws);
    const { next } = await firstPage(server, ws);
    writeFile(ws, "src/module_000/added_late.ts", "export {};\n");
    const { body } = await server.callTool(next.tool, next.arguments);
    expect(body["kind"], JSON.stringify(body)).toBe("refusal");
    expect(body["code"]).toBe("cursor-stale");
    expect(body["field"]).toBe("cursor");
    const restart = extractNext(body).next!;
    expect(restart.tool).toBe("tl_search_files");
    expect(restart.arguments["cursor"]).toBeUndefined();
    expect(restart.arguments["scope"]).toEqual({ path: ".", depth: 2 });
    expect(restart.arguments["budget"]).toEqual({ bytes: 1500 });
    const chain = await walkTree(server, restart.arguments);
    expect(concatenated(chain)).toContain("added_late.ts");
    expect(chain.capped).toBe(false);
  }, 60_000);

  it("re-sending the same cursor serves the same page (no hidden state advances)", async () => {
    const ws = freshWorkspace("resend");
    writeModules(ws);
    const server = await serverFor(ws);
    const { next } = await firstPage(server, ws);
    const a = await server.callTool(next.tool, next.arguments);
    const b = await server.callTool(next.tool, next.arguments);
    expect(a.body["tree"]).toBe(b.body["tree"]);
  }, 60_000);

  it("a resume may change its budget, and the page honours the new one", async () => {
    const ws = freshWorkspace("rebudget");
    writeModules(ws);
    const server = await serverFor(ws);
    const { body, next } = await firstPage(server, ws);
    const resumed = await server.callTool(next.tool, { ...next.arguments, budget: { bytes: 900 } });
    expect(resumed.body["kind"], JSON.stringify(resumed.body).slice(0, 300)).toBe("search.tree");
    expect(resumed.textBytes).toBeLessThanOrEqual(900);
    // The resumed page starts exactly where page 1 stopped.
    const pageOne = String(body["tree"]).slice(0, -MARKER.length).split("\n");
    const pageTwo = String(resumed.body["tree"]).split("\n");
    const listing = expectedListing(2).split("\n");
    expect(pageTwo[0]).toBe(listing[pageOne.length]);
    expect(extractNext(resumed.body).next?.arguments["budget"]).toEqual({ bytes: 900 });
  }, 60_000);

  it("a cursor cannot move to another root or depth: invalid-input names the scope field", async () => {
    const ws = freshWorkspace("scope");
    writeModules(ws);
    const server = await serverFor(ws);
    const { next } = await firstPage(server, ws);
    const otherRoot = (await server.callTool(next.tool, { ...next.arguments, scope: { path: "src", depth: 2 } })).body;
    expect(otherRoot["kind"], JSON.stringify(otherRoot)).toBe("refusal");
    expect(otherRoot["code"]).toBe("invalid-input");
    expect(otherRoot["field"]).toBe("scope.path");
    const otherDepth = (await server.callTool(next.tool, { ...next.arguments, scope: { path: ".", depth: 3 } })).body;
    expect(otherDepth["kind"], JSON.stringify(otherDepth)).toBe("refusal");
    expect(otherDepth["code"]).toBe("invalid-input");
    expect(otherDepth["field"]).toBe("scope.depth");
  }, 60_000);

  it("a forged or foreign cursor is refused cursor-invalid, with the original call as its next", async () => {
    const ws = freshWorkspace("invalid");
    writeModules(ws);
    const server = await serverFor(ws);
    const { next } = await firstPage(server, ws);
    const cursor = String(next.arguments["cursor"]);
    const forged = `${cursor.slice(0, -4)}${cursor.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    for (const bad of [forged, "not-a-cursor"]) {
      const { body } = await server.callTool("tl_search_files", { action: "tree", cwd: ws, cursor: bad, budget: { bytes: 1500 } });
      expect(body["kind"], JSON.stringify(body)).toBe("refusal");
      expect(body["code"]).toBe("cursor-invalid");
      expect(body["field"]).toBe("cursor");
      const restart = extractNext(body).next!;
      expect(restart.arguments["action"]).toBe("tree");
      expect(restart.arguments["cursor"]).toBeUndefined();
    }
    // A find cursor is not a tree cursor.
    writeFile(ws, "src/needles.ts", Array.from({ length: 200 }, (_, i) => `export const needle_${i} = ${i};`).join("\n") + "\n");
    const find = (await server.callTool("tl_search_files", { action: "find", queries: ["needle_"], cwd: ws, budget: { bytes: 2000 } })).body;
    const findCursor = extractNext(find).next?.arguments["cursor"];
    expect(typeof findCursor, JSON.stringify(find).slice(0, 300)).toBe("string");
    const crossed = (await server.callTool("tl_search_files", { action: "tree", cwd: ws, cursor: findCursor })).body;
    expect(crossed["kind"], JSON.stringify(crossed)).toBe("refusal");
    expect(crossed["code"]).toBe("cursor-invalid");
  }, 60_000);
});
