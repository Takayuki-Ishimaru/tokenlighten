/**
 * verificationKitLedgerGrounding.spec.ts — FX-O2 (ruling (s), 2026-09-03,
 * round-17 finding 7b / INV-G row 52).
 *
 * THE MEASURED DEFECT. `server.ts`'s `dropServedBody` (the verification-kit
 * body-inlining pass `attachVerification`/`withVerificationSection` run on
 * every `edit.applied`/`mode=closure` response) shipped a referencing test's
 * whole-file `code` body and recorded the fact ONLY in
 * `verificationSurfacesServed` (ledger 5) — a namespace `edit_file`'s
 * admissible union / byte residency (`admissibleEditPaths`/
 * `editPathResidency`, ledgers 2/3) never consult. A file a kit had JUST
 * shipped whole therefore still refused `edit_file` `execution-typestate`
 * unless some OTHER call had separately `read_file`'d it — union/residency
 * never heard about a kit-inlined body at all, even though real, non-partial
 * bytes of that exact file had genuinely gone out on the wire.
 *
 * THE FIX. `dropServedBody` now ALSO stages the same whole-file body through
 * `recordServedRange` (the funnel-exit-settled ledger every honest
 * `read.text` path already uses) — additively, alongside the unchanged
 * `markVerificationSurfaceServed` call (removing that call regressed
 * `replayCorpus.spec.ts`'s vkit2 wire-byte pin: a `servedRangeReceipt`-
 * sourced "served-earlier" always carries a `served_by` provenance string
 * ledger 5's own empty-object answer never did — see the fix report). No
 * `protocol/envelope.ts` change is needed for this one: its `servedWindowsOf`
 * walk already recognizes a bare `{path, code}` sibling pair as evidence
 * (`code` is one of its three recognized carrier fields), which is exactly
 * the shape a kit surface entry has.
 *
 * This spec proves the fix end to end through the REAL dispatch (`callTool`),
 * not a hand-built session state: edit a source file with a real referencing
 * test, then attempt an `edit_file` search/replace on that test file WITHOUT
 * ever separately `read_file`-ing it. Pre-fix this refuses
 * `execution-typestate`; post-fix it applies, grounded purely on the bytes
 * the verification kit inlined.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Body = Record<string, unknown>;
type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

let ws: string;
let callTool: (name: string, args: Body) => Promise<ToolResult>;

function write(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, "utf8");
}

async function edit(args: Body): Promise<Body> {
  const result = await callTool("edit_file", args);
  return JSON.parse(result.content[0]?.text ?? "{}") as Body;
}

async function read(args: Body): Promise<Body> {
  const result = await callTool("read_file", args);
  return JSON.parse(result.content[0]?.text ?? "{}") as Body;
}

beforeAll(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-vkit-ground-")));
  if (!process.argv.includes("--allow-write")) process.argv.push("--allow-write");
  process.env["TOKENLIGHTEN_ROOT"] = ws;
  const server = await import("../server.js");
  callTool = server.callTool as typeof callTool;
});

beforeEach(async () => {
  const { resetAll } = await import("../state/session.js");
  resetAll();
  const { handleTable } = await import("../util/handles.js");
  handleTable.reset();
});

afterEach(async () => {
  const { resetAll } = await import("../state/session.js");
  resetAll();
});

afterAll(() => {
  delete process.env["TOKENLIGHTEN_ROOT"];
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A source file plus a same-directory referencing test `buildVerificationManifest` inlines whole. */
function makeFixture(root: string): void {
  write(root, "src/mode_manager.cpp", "void request() { return; }\n");
  write(
    root,
    "test/test_mode_manager.cpp",
    '#include "mode/mode_manager.hpp"\nvoid t() { request(); }\n',
  );
}

/**
 * A live execution fence (task-pack certificate) is the precondition that
 * makes this whole class of defect observable at all: a PLAIN-mode edit (no
 * fence ever installed) applies to any file unconditionally, so a naive
 * "edit a never-read file" probe would pass both before and after the fix
 * for the wrong reason. Establishing a fence first — exactly the shape
 * `r17_g.mts` used — makes `edit_file`'s `execution-typestate` gate actually
 * consult `session.admissibleEditPaths` (`state/session.ts`'s
 * `outsidePaths = paths.filter(p => !fence.actionPaths.includes(p) &&
 * !session.admissibleEditPaths.includes(p))`), which is precisely the ledger
 * this fix's `recordServedRange` staging populates.
 */
async function establishFence(root: string): Promise<void> {
  await read({
    query: "Update request() so it does something new.",
    targets: [{ path: `${root}/src/mode_manager.cpp` }],
    task: { profile: "generic", epoch: "new" },
  });
}

describe("FX-O2 finding 7b — verification-kit code bodies ground edit authority", () => {
  it("edit_file on a referencing test file the kit JUST shipped applies, with no separate read_file ever issued for it", async () => {
    const root = "case1";
    makeFixture(path.join(ws, root));
    await establishFence(root);

    const firstEdit = await edit({
      path: `${root}/src/mode_manager.cpp`,
      search: "void request() { return; }",
      replace: "void request() { return; } // updated",
      precondition: "unique-match",
      allowPathFallback: false,
    });
    expect(firstEdit["kind"], JSON.stringify(firstEdit)).toBe("edit.applied");
    const verification = firstEdit["verification"] as Record<string, unknown> | undefined;
    expect(verification, JSON.stringify(firstEdit)).toBeDefined();
    const surfaces = (verification!["surfaces"] ?? []) as Array<Record<string, unknown>>;
    const testSurface = surfaces.find((s) => s["path"] === `${root}/test/test_mode_manager.cpp`);
    expect(testSurface, JSON.stringify(surfaces)).toBeDefined();
    expect(String(testSurface!["code"]), "the kit must inline this small referencing test's real body").toContain("request()");

    // No `read_file` of test/test_mode_manager.cpp has EVER been issued in
    // this session, and the fence's own frontier only ever named
    // src/mode_manager.cpp — the ONLY bytes of the test file this server
    // ever shipped are the kit's own `code` field above. Pre-fix this
    // refuses `execution-typestate` ("edit target is outside certificate
    // frontier") because `admissibleEditPaths` never heard about it; this
    // fix's staged `recordServedRange` call is what promotes it there.
    const testEdit = await edit({
      path: `${root}/test/test_mode_manager.cpp`,
      search: "void t() { request(); }",
      replace: "void t() { request(); } // touched",
      precondition: "unique-match",
      allowPathFallback: false,
    });
    expect(
      testEdit["kind"],
      `edit on a kit-shipped-but-never-separately-read file must apply, not refuse: ${JSON.stringify(testEdit)}`,
    ).toBe("edit.applied");
    const onDisk = fs.readFileSync(path.join(ws, root, "test/test_mode_manager.cpp"), "utf8");
    expect(onDisk).toContain("// touched");
  });

  it("CONTROL: under the SAME live fence, a file the kit never named or shipped still refuses execution-typestate — this fix grants authority only for bytes actually shipped", async () => {
    const root = "case2";
    makeFixture(path.join(ws, root));
    write(path.join(ws, root), "src/never_shipped.cpp", "void unrelated() {}\n");
    await establishFence(root);

    await edit({
      path: `${root}/src/mode_manager.cpp`,
      search: "void request() { return; }",
      replace: "void request() { return; } // updated",
      precondition: "unique-match",
      allowPathFallback: false,
    });

    const neverShippedEdit = await edit({
      path: `${root}/src/never_shipped.cpp`,
      search: "void unrelated() {}",
      replace: "void unrelated() { /* changed */ }",
      precondition: "unique-match",
      allowPathFallback: false,
    });
    expect(neverShippedEdit["kind"], JSON.stringify(neverShippedEdit)).toBe("refusal");
    expect(neverShippedEdit["code"]).toBe("execution-typestate");
  });
});
