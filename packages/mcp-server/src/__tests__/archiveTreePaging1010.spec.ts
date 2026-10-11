/**
 * archiveTreePaging1010.spec.ts — ATP (2026-10-10): the archive-scoped
 * `tl_search_files action:"tree"` pages its member listing, and a page that
 * stops short carries an executable `limit.next` that serves the REST of it.
 *
 * THE MEASURED DEFECT (develop 937f6cc4, before this fix). A 300-member zip
 * (`pkg/dirNN/file_NNN.txt`, 20 directories of 15 files), `scope:{archive:
 * {path:"bundle.zip"}}` and `scope:{path:"bundle.zip"}` alike:
 *
 *   no budget                1 call   4,968 B  200/300 members, limit {cause:"capped"}, no next
 *   budget {bytes:60000}     1 call   4,968 B  the same capped 200-member page
 *   budget {bytes:4000|2000} 1 call     259 B  refusal cap-exceeded, no next
 *
 * so members 201-300 were unreachable at every budget.
 *
 * ROOT CAUSE. `archiveTree` (tools/archive.ts) joined `buildArchiveManifest`'s
 * fixed 200-entry slice into `tree`; `projectTree` could fold its `truncated`
 * only into `capped`, and the wire ladder's tree rung (a shallower `depth`)
 * has nothing to shed on an archive tree, which has no depth.
 *
 * THE FIX (`tools/archiveTreePage.ts`): the workspace tree's TPB pager over the
 * whole member listing. No budget: the legacy page of at most 200 members, never
 * past the 8 KB `search.tree` row — and a listing of at most 200 members whose
 * whole answer fits the row is the unpaged answer, byte for byte. With
 * `budget.bytes`/`budget.tokens`: whole member lines within the tighter of the
 * budget and the row, refused `budget-below-minimum` (floor named) only when
 * one line cannot fit. A page that stops short carries `limit:{cause:"wire",
 * next}` — `scope.archive` (path, normalized prefix), the call's
 * `scope.credentialRef`, the declared budget, and a signed cursor bound to the
 * workspace, the archive path, the prefix, the archive's content digest and a
 * digest of the whole listing.
 *
 * Every case drives a REAL stdio server on the `full` tool surface (archives
 * are a full-surface capability) and follows each response's `limit.next`
 * verbatim, as AGENTS.md instructs a caller to.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { extractNext, startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { budgetFor } from "../protocol/budget/wireBudget.js";
import { ARCHIVE_LIMITS } from "../tools/archive.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const TREE_ROW_BYTES = budgetFor("search.tree");
const LEGACY_PAGE_MEMBERS = ARCHIVE_LIMITS.maxManifestEntries;

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-atp1010-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

async function serverFor(ws: string, extraEnv: Record<string, string> = {}): Promise<ServerHandle> {
  const server = startDevServer(ws, "default", { toolSurface: "full", extraEnv });
  servers.push(server);
  await server.initialize();
  return server;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Members = ReadonlyArray<readonly [string, string]>;

type TestZip = {
  file(name: string, data: string, options?: { createFolders?: boolean }): void;
  generateAsync(options: { type: "nodebuffer"; compression: "DEFLATE" }): Promise<Buffer>;
};

async function plainZip(members: Members): Promise<Buffer> {
  const JSZipModule = (await import("jszip")) as unknown as { default: new () => TestZip };
  const zip = new JSZipModule.default();
  for (const [name, text] of members) zip.file(name, text, { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * The review's 300 members (member i in `pkg/dir<i % 20>/file_<i>.txt`),
 * grouped by directory: the archive backend lists members grouped by
 * directory in first-seen order, so this insertion order IS the listing order.
 */
function reviewMembers(): string[] {
  const out: string[] = [];
  for (let d = 0; d < 20; d++) {
    for (let k = 0; k < 15; k++) {
      out.push(`pkg/dir${String(d).padStart(2, "0")}/file_${String(d + 20 * k).padStart(3, "0")}.txt`);
    }
  }
  return out;
}

function withContent(names: readonly string[]): Members {
  return names.map((name, i) => [name, `x${i}\n`] as const);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crcStep = (crc: number, byte: number): number => (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;

/**
 * A STORED zip whose every member is ZipCrypto (traditional PKWARE) encrypted —
 * jszip cannot write one, and the one encrypted fixture in archiveRead.spec.ts
 * has two members, too few to page.
 */
function encryptedZip(password: string, members: Members): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 10;
  for (const [name, text] of members) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    let crc = 0xffffffff;
    for (const byte of data) crc = crcStep(crc, byte);
    crc = (crc ^ 0xffffffff) >>> 0;
    let k0 = 0x12345678;
    let k1 = 0x23456789;
    let k2 = 0x34567890;
    const update = (byte: number): void => {
      k0 = crcStep(k0, byte);
      k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
      k2 = crcStep(k2, k1 >>> 24);
    };
    for (const byte of Buffer.from(password, "utf8")) update(byte);
    const header = Buffer.alloc(12, 0x5a);
    header[11] = (crc >>> 24) & 0xff;
    const plain = Buffer.concat([header, data]);
    const sealed = Buffer.alloc(plain.length);
    for (let i = 0; i < plain.length; i++) {
      const t = (k2 | 2) & 0xffff;
      sealed[i] = plain[i]! ^ (((t * (t ^ 1)) >>> 8) & 0xff);
      update(plain[i]!);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(1, 6); // encrypted
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(sealed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(1, 8);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(sealed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, sealed);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + sealed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// ---------------------------------------------------------------------------
// Chain walking
// ---------------------------------------------------------------------------

type Call = { tool: string; arguments: Record<string, unknown> };

interface Page {
  body: Record<string, unknown>;
  textBytes: number;
}

interface Chain {
  pages: Page[];
  /** True when the walk stopped at the hop cap with a `limit.next` still pending. */
  capped: boolean;
}

function limitNext(body: Record<string, unknown>): Call | undefined {
  const next = (body["limit"] as { next?: Call } | undefined)?.next;
  return next !== undefined && typeof next.tool === "string" ? next : undefined;
}

/** Run `args`, then every `limit.next` verbatim until a page carries none (or a refusal ends the chain). */
async function walk(server: ServerHandle, args: Record<string, unknown>, hopCap = 60): Promise<Chain> {
  const pages: Page[] = [];
  let call: Call | undefined = { tool: "tl_search_files", arguments: args };
  while (call !== undefined && pages.length < hopCap) {
    const { body, textBytes } = await server.callTool(call.tool, call.arguments);
    pages.push({ body: body as Record<string, unknown>, textBytes });
    call = limitNext(body as Record<string, unknown>);
  }
  return { pages, capped: call !== undefined };
}

function pageMembers(page: Page): string[] {
  const tree = String(page.body["tree"] ?? "");
  return tree === "" ? [] : tree.split("\n");
}

function describeChain(chain: Chain): string {
  return `calls=${chain.pages.length} pages=[${chain.pages
    .map((page) => {
      const limit = page.body["limit"] as Record<string, unknown> | undefined;
      const tail = page.body["kind"] === "refusal" ? `refusal:${String(page.body["code"])}` : String(limit?.["cause"] ?? "-");
      return `${page.textBytes}B/${pageMembers(page).length}m/${tail}`;
    })
    .join(" ")}]`;
}

/**
 * The chain completed without a refusal and delivered exactly `members` (every
 * one once, in listing order, whole lines only); every page but the last said
 * `limit:{cause:"wire"}` with a cursor continuation of the SAME archive scope
 * and budget; only the last page is complete.
 */
function expectWholeListing(
  chain: Chain,
  members: readonly string[],
  expected: { root: string; scope: Record<string, unknown>; budget?: Record<string, unknown> },
): void {
  const refusals = chain.pages.filter((page) => page.body["kind"] === "refusal");
  expect(refusals.map((page) => JSON.stringify(page.body).slice(0, 400))).toEqual([]);
  expect(chain.capped, `chain never completed: ${describeChain(chain)}`).toBe(false);
  expect(chain.pages.flatMap(pageMembers), describeChain(chain)).toEqual([...members]);
  chain.pages.forEach((page, index) => {
    expect(page.body["kind"]).toBe("search.tree");
    expect(page.body["root"]).toBe(expected.root);
    expect((page.body["archive"] as Record<string, unknown>)["total_entries"]).toBe(members.length);
    if (index === chain.pages.length - 1) {
      expect(page.body["limit"], "the last page carries no limit").toBeUndefined();
      return;
    }
    const limit = page.body["limit"] as Record<string, unknown>;
    expect(limit["cause"], JSON.stringify(limit)).toBe("wire");
    expect(limit["omitted"]).toEqual(["results"]);
    const next = limitNext(page.body)!;
    expect(next.tool).toBe("tl_search_files");
    expect(next.arguments["action"]).toBe("tree");
    expect(next.arguments["scope"]).toEqual(expected.scope);
    expect(typeof next.arguments["cursor"]).toBe("string");
    expect(next.arguments["budget"]).toEqual(expected.budget);
  });
}

/** The JSON a continuation cursor authenticates (its `aad`), decoded from the token. */
function cursorPayload(cursor: string): { raw: string; payload: Record<string, unknown> } {
  const prefix = "tlh_cont_v1_";
  expect(cursor.startsWith(prefix), cursor).toBe(true);
  const raw = Buffer.from(cursor.slice(prefix.length), "base64url").toString("latin1");
  const start = raw.indexOf("{\"v\":1");
  expect(start, raw).toBeGreaterThanOrEqual(0);
  return { raw, payload: JSON.parse(raw.slice(start, raw.indexOf("}", start) + 1)) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// One workspace for the read-only cases
// ---------------------------------------------------------------------------

const REVIEW = reviewMembers();
const DIR03 = REVIEW.filter((member) => member.startsWith("pkg/dir03/"));
/** 240 members under one prefix: more than the legacy page holds. */
const DEEP = [
  ...Array.from({ length: 240 }, (_, i) => `pkg/dir03/part_${String(i).padStart(3, "0")}.txt`),
  ...Array.from({ length: 20 }, (_, i) => `pkg/other/note_${String(i).padStart(2, "0")}.txt`),
];
const DEEP_DIR03 = DEEP.filter((member) => member.startsWith("pkg/dir03/"));
const SMALL = REVIEW.slice(0, 30);
const AT_CAP = REVIEW.slice(0, LEGACY_PAGE_MEMBERS);
/** 150 members whose whole listing is far past the 8 KB row. */
const LONG = Array.from(
  { length: 150 },
  (_, i) => `pkg/a-rather-long-directory-name-for-the-row/module_${String(i).padStart(3, "0")}/component_with_a_long_file_name_${String(i).padStart(3, "0")}.txt`,
);

let shared: { ws: string; server: ServerHandle } | undefined;

async function sharedFixture(): Promise<{ ws: string; server: ServerHandle }> {
  if (shared !== undefined) return shared;
  const ws = freshWorkspace("shared");
  fs.writeFileSync(path.join(ws, "bundle.zip"), await plainZip(withContent(REVIEW)));
  fs.writeFileSync(path.join(ws, "other.zip"), await plainZip(withContent(REVIEW)));
  fs.writeFileSync(path.join(ws, "deep.zip"), await plainZip(withContent(DEEP)));
  fs.writeFileSync(path.join(ws, "small.zip"), await plainZip(withContent(SMALL)));
  fs.writeFileSync(path.join(ws, "cap.zip"), await plainZip(withContent(AT_CAP)));
  fs.writeFileSync(path.join(ws, "long.zip"), await plainZip(withContent(LONG)));
  // Plain files, so the WORKSPACE tree has a cursor of its own to cross with.
  for (let i = 0; i < 120; i++) {
    const file = path.join(ws, "src", `module_${String(i).padStart(3, "0")}.ts`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `export const v${i} = ${i};\n`, "utf8");
  }
  shared = { ws, server: await serverFor(ws) };
  return shared;
}

const ARCHIVE_SCOPE = { archive: { path: "bundle.zip" } };
const PATH_SCOPE = { path: "bundle.zip" };

// ---------------------------------------------------------------------------
// R1. No budget.
// ---------------------------------------------------------------------------

describe("ATP R1: no budget — the legacy page, now with a next", () => {
  for (const [label, scope] of [["scope.archive", ARCHIVE_SCOPE], ["scope.path", PATH_SCOPE]] as const) {
    it(`${label}: the first page is still the first 200 members, and its next serves members 201-300`, async () => {
      const { ws, server } = await sharedFixture();
      const chain = await walk(server, { action: "tree", cwd: ws, scope });
      // Was: one 4,968 B page of 200 members, limit {cause:"capped"}, no next.
      expectWholeListing(chain, REVIEW, { root: "bundle.zip!/", scope: ARCHIVE_SCOPE });
      expect(chain.pages.length, describeChain(chain)).toBe(2);
      expect(pageMembers(chain.pages[0]!)).toEqual(REVIEW.slice(0, LEGACY_PAGE_MEMBERS));
      for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(TREE_ROW_BYTES);
    }, 120_000);
  }

  for (const [name, members] of [["small.zip", SMALL], ["cap.zip", AT_CAP]] as const) {
    it(`${name} (${members.length} members, at most the legacy page): byte-identical to the unpaged answer`, async () => {
      const { ws, server } = await sharedFixture();
      const { body, textBytes } = await server.callTool("tl_search_files", { action: "tree", cwd: ws, scope: { archive: { path: name } } });
      // The develop 937f6cc4 wire shape, member for member: no limit, no next,
      // no truncation marker, no new field.
      const unpaged = JSON.stringify({
        v: 1,
        kind: "search.tree",
        root: `${name}!/`,
        tree: members.join("\n"),
        archive: { format: "zip", total_entries: members.length, warnings: [] },
      });
      expect(JSON.stringify(body)).toBe(unpaged);
      expect(textBytes).toBe(Buffer.byteLength(unpaged, "utf8"));
    }, 120_000);
  }

  it("a listing of at most 200 members whose answer is past the 8 KB row pages within the row (was refusal cap-exceeded)", async () => {
    const { ws, server } = await sharedFixture();
    const chain = await walk(server, { action: "tree", cwd: ws, scope: { archive: { path: "long.zip" } } });
    expectWholeListing(chain, LONG, { root: "long.zip!/", scope: { archive: { path: "long.zip" } } });
    expect(chain.pages.length, describeChain(chain)).toBeGreaterThanOrEqual(2);
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(TREE_ROW_BYTES);
  }, 120_000);

  it("a prefix with more members than the legacy page pages within the prefix, its normalized prefix echoed", async () => {
    const { ws, server } = await sharedFixture();
    const chain = await walk(server, { action: "tree", cwd: ws, scope: { archive: { path: "deep.zip", prefix: "./pkg//dir03/" } } });
    // Was: 200 of the 240 prefix members, limit {cause:"capped"}, no next.
    expectWholeListing(chain, DEEP_DIR03, { root: "deep.zip!/", scope: { archive: { path: "deep.zip", prefix: "pkg/dir03" } } });
    expect(chain.pages.map((page) => pageMembers(page).length)).toEqual([200, 40]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// R2. A declared budget.
// ---------------------------------------------------------------------------

describe("ATP R2: budget.bytes / budget.tokens — whole member lines within the budget and the row", () => {
  for (const bytes of [2000, 4000]) {
    for (const [label, scope] of [["scope.archive", ARCHIVE_SCOPE], ["scope.path", PATH_SCOPE]] as const) {
      it(`${label}, budget {bytes:${bytes}}: below the old fixed page it pages instead of refusing, every page filled and within it`, async () => {
        const { ws, server } = await sharedFixture();
        const chain = await walk(server, { action: "tree", cwd: ws, scope, budget: { bytes } });
        // Was: refusal cap-exceeded ("measured 4968 B against a <bytes> B wire budget"), no next.
        expectWholeListing(chain, REVIEW, { root: "bundle.zip!/", scope: ARCHIVE_SCOPE, budget: { bytes } });
        expect(chain.pages.length, describeChain(chain)).toBeGreaterThanOrEqual(2);
        for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(bytes);
        for (const page of chain.pages.slice(0, -1)) {
          expect(page.textBytes, describeChain(chain)).toBeGreaterThanOrEqual(0.85 * bytes);
        }
      }, 120_000);
    }
  }

  for (const [label, scope] of [["scope.archive", ARCHIVE_SCOPE], ["scope.path", PATH_SCOPE]] as const) {
    it(`${label}, budget {bytes:60000}: one page of all 300 members within the ${TREE_ROW_BYTES} B row`, async () => {
      const { ws, server } = await sharedFixture();
      const chain = await walk(server, { action: "tree", cwd: ws, scope, budget: { bytes: 60000 } });
      // Was: the same capped 200-member page as with no budget.
      expectWholeListing(chain, REVIEW, { root: "bundle.zip!/", scope: ARCHIVE_SCOPE, budget: { bytes: 60000 } });
      expect(chain.pages.length, describeChain(chain)).toBe(1);
      expect(chain.pages[0]!.textBytes).toBeLessThanOrEqual(TREE_ROW_BYTES);
    }, 120_000);
  }

  it("budget {tokens:500} binds like the 2000 B it converts to, and is echoed as declared", async () => {
    const { ws, server } = await sharedFixture();
    const chain = await walk(server, { action: "tree", cwd: ws, scope: ARCHIVE_SCOPE, budget: { tokens: 500 } });
    expectWholeListing(chain, REVIEW, { root: "bundle.zip!/", scope: ARCHIVE_SCOPE, budget: { tokens: 500 } });
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(2000);
  }, 120_000);

  it("a budget below one member line plus its envelope is refused budget-below-minimum, and its floor carries the whole chain", async () => {
    const { ws, server } = await sharedFixture();
    // small.zip: at the floor a page that stops short holds about one line, so
    // a short listing keeps the walk short.
    const scope = { archive: { path: "small.zip" } };
    const first = (await server.callTool("tl_search_files", { action: "tree", cwd: ws, scope, budget: { bytes: 300 } })).body as Record<string, unknown>;
    // Was: refusal cap-exceeded with no floor.
    expect(first["kind"], JSON.stringify(first)).toBe("refusal");
    expect(first["code"]).toBe("budget-below-minimum");
    expect(first["field"]).toBe("budget");
    expect(first["tree"]).toBeUndefined();
    const floor = first["required_min_bytes"];
    expect(typeof floor === "number" && floor > 300 && floor < TREE_ROW_BYTES, JSON.stringify(first)).toBe(true);
    const chain = await walk(server, { action: "tree", cwd: ws, scope, budget: { bytes: floor } });
    expectWholeListing(chain, SMALL, { root: "small.zip!/", scope, budget: { bytes: floor } });
    expect(chain.pages.length, describeChain(chain)).toBeGreaterThanOrEqual(2);
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(floor as number);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// R3. The cursor.
// ---------------------------------------------------------------------------

describe("ATP R3: the archive tree cursor — signed, bound, and never a change of scope", () => {
  async function firstPage(
    server: ServerHandle,
    ws: string,
    scope: Record<string, unknown> = ARCHIVE_SCOPE,
    extra: Record<string, unknown> = {},
  ): Promise<{ body: Record<string, unknown>; next: Call }> {
    const { body } = await server.callTool("tl_search_files", { action: "tree", cwd: ws, scope, budget: { bytes: 2000 }, ...extra });
    const next = limitNext(body as Record<string, unknown>);
    expect(next, JSON.stringify(body).slice(0, 400)).toBeDefined();
    return { body: body as Record<string, unknown>, next: next! };
  }

  it("the cursor carries digests and a position only, bound to the archive's content digest (its sha256)", async () => {
    const { ws, server } = await sharedFixture();
    const { next } = await firstPage(server, ws);
    const { raw, payload } = cursorPayload(String(next.arguments["cursor"]));
    expect(payload["t"]).toBe("archive-tree");
    const sha = createHash("sha256").update(fs.readFileSync(path.join(ws, "bundle.zip"))).digest("hex");
    expect(payload["a"]).toBe(sha.slice(0, 16));
    expect(typeof payload["o"]).toBe("number");
    for (const leak of ["bundle.zip", "pkg/", ws]) expect(raw).not.toContain(leak);
  }, 120_000);

  it("archive bytes that changed under the cursor — the same member names — are refused cursor-stale, with the restart call as next", async () => {
    const ws = freshWorkspace("stale-bytes");
    fs.writeFileSync(path.join(ws, "bundle.zip"), await plainZip(withContent(REVIEW)));
    const server = await serverFor(ws);
    const { next } = await firstPage(server, ws);
    // Same 300 names, one member's content changed: the listing is identical, the archive is not.
    fs.writeFileSync(path.join(ws, "bundle.zip"), await plainZip(REVIEW.map((name, i) => [name, i === 0 ? "changed\n" : `x${i}\n`] as const)));
    const { body } = await server.callTool(next.tool, next.arguments);
    expect(body["kind"], JSON.stringify(body)).toBe("refusal");
    expect(body["code"]).toBe("cursor-stale");
    expect(body["field"]).toBe("cursor");
    expect(body["tree"]).toBeUndefined();
    const restart = extractNext(body).next!;
    expect(restart.tool).toBe("tl_search_files");
    expect(restart.arguments["cursor"]).toBeUndefined();
    expect(restart.arguments["scope"]).toEqual(ARCHIVE_SCOPE);
    expect(restart.arguments["budget"]).toEqual({ bytes: 2000 });
    const chain = await walk(server, restart.arguments);
    expectWholeListing(chain, REVIEW, { root: "bundle.zip!/", scope: ARCHIVE_SCOPE, budget: { bytes: 2000 } });
  }, 120_000);

  it("a member added under the cursor is refused cursor-stale, and the restart serves the new listing", async () => {
    const ws = freshWorkspace("stale-listing");
    fs.writeFileSync(path.join(ws, "bundle.zip"), await plainZip(withContent(REVIEW)));
    const server = await serverFor(ws);
    const { next } = await firstPage(server, ws);
    const grown = [...REVIEW, "pkg/dir19/added_late.txt"];
    fs.writeFileSync(path.join(ws, "bundle.zip"), await plainZip(withContent(grown)));
    const { body } = await server.callTool(next.tool, next.arguments);
    expect(body["kind"], JSON.stringify(body)).toBe("refusal");
    expect(body["code"]).toBe("cursor-stale");
    const chain = await walk(server, extractNext(body).next!.arguments);
    expectWholeListing(chain, grown, { root: "bundle.zip!/", scope: ARCHIVE_SCOPE, budget: { bytes: 2000 } });
  }, 120_000);

  it("a forged, garbled or foreign cursor is refused cursor-invalid, with the original call as next", async () => {
    const { ws, server } = await sharedFixture();
    const { next } = await firstPage(server, ws);
    const cursor = String(next.arguments["cursor"]);
    const forged = `${cursor.slice(0, -4)}${cursor.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    // A workspace tree cursor is not an archive tree cursor.
    const workspaceTree = (await server.callTool("tl_search_files", { action: "tree", cwd: ws, scope: { path: "src" }, budget: { bytes: 1000 } })).body;
    const workspaceCursor = extractNext(workspaceTree).next?.arguments["cursor"];
    expect(typeof workspaceCursor, JSON.stringify(workspaceTree).slice(0, 300)).toBe("string");
    for (const bad of [forged, "not-a-cursor", String(workspaceCursor)]) {
      const { body } = await server.callTool("tl_search_files", { action: "tree", cwd: ws, scope: ARCHIVE_SCOPE, cursor: bad, budget: { bytes: 2000 } });
      expect(body["kind"], JSON.stringify(body)).toBe("refusal");
      expect(body["code"]).toBe("cursor-invalid");
      expect(body["field"]).toBe("cursor");
      expect(body["tree"]).toBeUndefined();
      const restart = extractNext(body).next!;
      expect(restart.arguments["action"]).toBe("tree");
      expect(restart.arguments["cursor"]).toBeUndefined();
      expect(restart.arguments["scope"]).toEqual(ARCHIVE_SCOPE);
    }
    // ...and an archive tree cursor cannot list the WORKSPACE.
    const crossed = (await server.callTool("tl_search_files", { action: "tree", cwd: ws, cursor })).body;
    expect(crossed["kind"], JSON.stringify(crossed)).toBe("refusal");
    expect(crossed["code"]).toBe("cursor-invalid");
  }, 120_000);

  it("a cursor is bound to its workspace: the byte-identical archive in another workspace refuses it cursor-invalid", async () => {
    const { ws, server } = await sharedFixture();
    const { next } = await firstPage(server, ws);
    // Same path, same prefix, same bytes, same listing: only the workspace differs.
    const twin = freshWorkspace("twin");
    fs.copyFileSync(path.join(ws, "bundle.zip"), path.join(twin, "bundle.zip"));
    const { body } = await server.callTool(next.tool, { ...next.arguments, cwd: twin });
    expect(body["kind"], JSON.stringify(body)).toBe("refusal");
    expect(body["code"]).toBe("cursor-invalid");
    expect(String(body["detail"])).toContain("wrong-workspace");
    expect(body["tree"]).toBeUndefined();
    // Its restart lists the twin from the first member.
    const restart = extractNext(body).next!;
    expect(restart.arguments["cursor"]).toBeUndefined();
    const chain = await walk(server, restart.arguments);
    expectWholeListing(chain, REVIEW, { root: "bundle.zip!/", scope: ARCHIVE_SCOPE, budget: { bytes: 2000 } });
  }, 120_000);

  it("a cursor presented with another archive or prefix is refused invalid-input naming the field — it never widens or moves the scope", async () => {
    const { ws, server } = await sharedFixture();
    const { next } = await firstPage(server, ws);
    const resumeWith = async (scope: Record<string, unknown>): Promise<Record<string, unknown>> =>
      (await server.callTool(next.tool, { ...next.arguments, scope })).body as Record<string, unknown>;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ archive: { path: "other.zip" } }, "scope.archive.path"],
      [{ path: "other.zip" }, "scope.path"],
      [{ archive: { path: "bundle.zip", prefix: "pkg/dir03" } }, "scope.archive.prefix"],
      [{ archive: { path: "bundle.zip", member: "pkg/dir03" } }, "scope.archive.member"],
    ];
    for (const [scope, field] of cases) {
      const body = await resumeWith(scope);
      expect(body["kind"], `${JSON.stringify(scope)}: ${JSON.stringify(body)}`).toBe("refusal");
      expect(body["code"]).toBe("invalid-input");
      expect(body["field"]).toBe(field);
      expect(body["tree"]).toBeUndefined();
    }
    // A cursor minted under a prefix cannot be resumed without it (widening).
    const narrow = await firstPage(server, ws, { archive: { path: "deep.zip", prefix: "pkg/dir03" } });
    const widened = (await server.callTool(narrow.next.tool, { ...narrow.next.arguments, scope: { archive: { path: "deep.zip" } } })).body;
    expect(widened["kind"], JSON.stringify(widened)).toBe("refusal");
    expect(widened["code"]).toBe("invalid-input");
    expect(widened["field"]).toBe("scope.archive.prefix");
    // The SAME archive under another spelling is the same scope: it resumes.
    for (const scope of [{ path: "bundle.zip" }, { archive: { path: "./bundle.zip" } }]) {
      const body = await resumeWith(scope);
      expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("search.tree");
    }
  }, 120_000);

  it("re-sending a cursor serves the same page, and a resume may change its budget", async () => {
    const { ws, server } = await sharedFixture();
    const { body, next } = await firstPage(server, ws);
    const a = await server.callTool(next.tool, next.arguments);
    const b = await server.callTool(next.tool, next.arguments);
    expect(a.body["tree"]).toBe(b.body["tree"]);
    const resumed = await server.callTool(next.tool, { ...next.arguments, budget: { bytes: 1200 } });
    expect(resumed.body["kind"], JSON.stringify(resumed.body).slice(0, 300)).toBe("search.tree");
    expect(resumed.textBytes).toBeLessThanOrEqual(1200);
    // The resumed page starts exactly where page 1 stopped.
    const pageOne = pageMembers({ body, textBytes: 0 });
    expect(pageMembers({ body: resumed.body as Record<string, unknown>, textBytes: 0 })[0]).toBe(REVIEW[pageOne.length]);
    expect(limitNext(resumed.body as Record<string, unknown>)?.arguments["budget"]).toEqual({ bytes: 1200 });
  }, 120_000);

  it("an encrypted archive pages with its credentialRef echoed on every continuation; the password never rides a cursor", async () => {
    const ws = freshWorkspace("encrypted");
    const password = "atp-s3cret-pass";
    const members = Array.from({ length: 120 }, (_, i) => `secret/part_${String(i).padStart(3, "0")}.txt`);
    fs.writeFileSync(path.join(ws, "locked.zip"), encryptedZip(password, withContent(members)));
    const server = await serverFor(ws, { TOKENLIGHTEN_PASSWORD_ATP_ZIP: password });
    const scope = { archive: { path: "locked.zip" }, credentialRef: "atp-zip" };
    const chain = await walk(server, { action: "tree", cwd: ws, scope, budget: { bytes: 1500 } });
    expectWholeListing(chain, members, { root: "locked.zip!/", scope, budget: { bytes: 1500 } });
    expect(chain.pages.length, describeChain(chain)).toBeGreaterThanOrEqual(2);
    for (const page of chain.pages.slice(0, -1)) {
      const cursor = String(limitNext(page.body)!.arguments["cursor"]);
      const { raw } = cursorPayload(cursor);
      for (const leak of [password, "locked.zip", "secret/"]) expect(raw).not.toContain(leak);
      expect(JSON.stringify(page.body)).not.toContain(password);
    }
    // Without the credential the same cursor lists nothing.
    const next = limitNext(chain.pages[0]!.body)!;
    const bare = (await server.callTool(next.tool, { ...next.arguments, scope: { archive: { path: "locked.zip" } } })).body;
    expect(bare["kind"], JSON.stringify(bare)).toBe("refusal");
    expect(bare["code"]).toBe("archive-encrypted");
    expect(bare["tree"]).toBeUndefined();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// R4. Exhaustion: every member exactly once, in order, at every budget.
// ---------------------------------------------------------------------------

describe("ATP R4: following limit.next verbatim lists every member exactly once, in archive order", () => {
  for (const budget of [undefined, { bytes: 2000 }, { bytes: 60000 }]) {
    for (const [label, scope] of [["scope.archive", ARCHIVE_SCOPE], ["scope.path", PATH_SCOPE]] as const) {
      it(`${label}, ${budget === undefined ? "no budget" : `budget ${JSON.stringify(budget)}`}`, async () => {
        const { ws, server } = await sharedFixture();
        const chain = await walk(server, { action: "tree", cwd: ws, scope, ...(budget !== undefined ? { budget } : {}) });
        expectWholeListing(chain, REVIEW, { root: "bundle.zip!/", scope: ARCHIVE_SCOPE, ...(budget !== undefined ? { budget } : {}) });
        expect(new Set(chain.pages.flatMap(pageMembers)).size).toBe(300);
      }, 120_000);
    }
    it(`scope.archive with prefix "pkg/dir03", ${budget === undefined ? "no budget" : `budget ${JSON.stringify(budget)}`}`, async () => {
      const { ws, server } = await sharedFixture();
      const scope = { archive: { path: "bundle.zip", prefix: "pkg/dir03" } };
      const chain = await walk(server, { action: "tree", cwd: ws, scope, ...(budget !== undefined ? { budget } : {}) });
      expectWholeListing(chain, DIR03, { root: "bundle.zip!/", scope, ...(budget !== undefined ? { budget } : {}) });
    }, 120_000);
  }
});

// ---------------------------------------------------------------------------
// R5. Archive reads select by prefix exactly as before (the manifest shares the
// prefix normalization the tree now uses).
// ---------------------------------------------------------------------------

describe("ATP R5: the archive manifest read is unchanged", () => {
  it("a prefixed manifest lists the same members for every spelling of the prefix", async () => {
    const { ws, server } = await sharedFixture();
    for (const prefix of ["pkg/dir03", "pkg/dir03/", "./pkg//dir03/"]) {
      const { body } = await server.callTool("tl_read_file", { cwd: ws, targets: [{ archive: { path: "bundle.zip", prefix } }] });
      expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("read.artifact");
      const entries = ((body["content"] as Record<string, unknown>)["entries"] as Array<Record<string, unknown>>);
      expect(entries.map((entry) => entry["member"])).toEqual(DIR03);
      for (const entry of entries) expect(typeof entry["handle"]).toBe("string");
    }
  }, 120_000);
});
