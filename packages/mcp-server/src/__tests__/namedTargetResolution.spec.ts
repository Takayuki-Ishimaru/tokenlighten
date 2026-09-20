// namedTargetResolution.spec.ts — regression coverage for
// TL_NAMED_TARGET_RESOLUTION (WP-S8, 2026-09-20).
//
// DEFECT UNDER TEST (recorded live GitHub Copilot session, 2026-09-20): the
// model's FIRST call named ten `targets`, each with its own `purpose`, plus a
// Japanese question. Three targets were file paths whose FOLDER it had guessed
// (`frontend/order.js` where `frontend/js/order.js` exists); three were
// DIRECTORIES, one of them holding the very classes the question was about.
// The pack served the four exact paths, reported the three guesses as
// `missing`, and drew NOTHING out of any directory — so the model spent two
// more turns (three parallel `find`s, then a second pack) recovering material
// it had already named. One extra model turn prices at roughly 9-14 KB of
// served source on every host measured, so the recovery is the expensive half.
//
// The call shape under test is the exact regression shape: ONE `buildTaskPack`
// with a `query` plus caller-named `paths` (files, guessed files and
// directories, each with a `purpose`), run in-process — this exercises the
// pack builder, not the transport, so no server is spawned.
//
// THE POLICY IS DEFAULT OFF (USER ruling 2026-09-20: the Claude Code paired
// bench must not move against v0.14.0). It is switched on per host by
// `tl workspace setup` through the TL_TURN_ECONOMY umbrella, or per policy by
// an explicit TL_NAMED_TARGET_RESOLUTION value — so every case below that
// exercises the new serving shape opts in explicitly, and the stock (unset)
// environment is the byte-identical one.
//
// Every fixture is generated into `os.tmpdir()` by this file; no bench fixture,
// corpus, or session path is read. Each test gets its OWN workspace on purpose:
// the pack's cross-call body dedupe is keyed by workspace, so replaying the
// same call under the two flag values inside one process would otherwise get a
// body-withholding receipt for the second run rather than a second pack.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildTaskPack, type TaskPackSurface } from "../features/task-pack/readCodeTaskPack.js";

const FLAG = "TL_NAMED_TARGET_RESOLUTION";
const UMBRELLA = "TL_TURN_ECONOMY";

/** Enough distinct statements that a surface is a real body rather than a stub. */
function body(tag: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `  const ${tag}Step${i} = ${i} * 31 + ${i};`).join("\n");
}

function serviceModule(name: string, fn: string, lines: number): string {
  return [
    `// ${name} — one concern of the billing flow.`,
    `export function ${fn}(id: string): string {`,
    body(fn, lines),
    `  return id;`,
    "}",
    "",
  ].join("\n");
}

const FILES: Readonly<Record<string, string>> = {
  // --- rule 1: basename resolution -----------------------------------------
  // Unique in the whole workspace: `web/order.js` resolves here.
  "web/scripts/order.js": "export function submitOrder(id) {\n  return id;\n}\n",
  // Two `cart.js` exist, but exactly one lies under the named parent (`web/`).
  "web/scripts/cart.js": "export function emptyCart(id) {\n  return id;\n}\n",
  "vendor/cart.js": "export function vendorCart(id) {\n  return id;\n}\n",
  // Two `util.js` exist and NEITHER lies under the named parent (`src/`).
  "lib/util.js": "export function libUtil() {\n  return 1;\n}\n",
  "tools/util.js": "export function toolUtil() {\n  return 2;\n}\n",
  // An exact path the caller can name without guessing.
  "web/scripts/api.js": "export function callApi(id) {\n  return id;\n}\n",
  // --- rule 2: a caller-named directory ------------------------------------
  "services/refundLedger.ts": serviceModule("refundLedger", "refundPayment", 40),
  "services/stockKeeper.ts": serviceModule("stockKeeper", "releaseStock", 40),
  "services/purchaseFlow.ts": serviceModule("purchaseFlow", "cancelPurchase", 40),
  "services/mailer.ts": serviceModule("mailer", "sendMail", 40),
  // A directory whose contents share no vocabulary with any clause below.
  "vendor/shims/zlibShim.ts": "export function inflateBuffer(x: string): string {\n  return x;\n}\n",
};

const workspaces: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-named-target-"));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  return root;
}

afterEach(() => {
  delete process.env[FLAG];
  delete process.env[UMBRELLA];
  for (const root of workspaces.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface PackEntry {
  path: string;
  purpose?: string;
  range?: string;
  symbol?: string;
}

interface PackResult {
  surfaces: TaskPackSurface[];
  missing: string[];
}

async function pack(
  workspace: string,
  query: string,
  paths: PackEntry[],
  taskProfile: "answer" | "generic" = "answer",
  extra: Record<string, unknown> = {},
): Promise<PackResult> {
  return await buildTaskPack({ query, paths, taskProfile, ...extra } as never, workspace) as never;
}

function surfaceFor(result: PackResult, rel: string): TaskPackSurface | undefined {
  return result.surfaces.find((surface) => surface.path === rel);
}

/** Surfaces this pack drew out of `dir` that the CALLER did not name as files. */
function surfacesUnder(result: PackResult, dir: string): TaskPackSurface[] {
  return result.surfaces.filter((surface) => surface.path.startsWith(dir + "/"));
}

// The clauses the directory cases locate with: three separable concerns, each
// answered by exactly one module in `services/`.
const SERVICE_QUERY =
  "Explain the refund path. Where is stock released? Which function cancels a purchase?";

// ---------------------------------------------------------------------------
// Opt-in wiring: default OFF everywhere, on per host through TL_TURN_ECONOMY.
// ---------------------------------------------------------------------------

describe("the TL_TURN_ECONOMY umbrella", () => {
  const query = "Explain how an order is submitted";
  const paths: PackEntry[] = [{ path: "web/order.js", purpose: "order submission" }];

  it("stock environment (neither variable set): the guessed path stays missing and nothing is resolved", async () => {
    const result = await pack(makeWorkspace(), query, paths);
    expect(result.missing).toContain("web/order.js");
    expect(surfaceFor(result, "web/scripts/order.js")).toBeUndefined();
  });

  it("TL_TURN_ECONOMY=1 alone turns the policy on", async () => {
    process.env[UMBRELLA] = "1";
    const result = await pack(makeWorkspace(), query, paths);
    expect(result.missing).not.toContain("web/order.js");
    expect(surfaceFor(result, "web/scripts/order.js")).toBeDefined();
  });

  it("TL_TURN_ECONOMY=1 with an explicit TL_NAMED_TARGET_RESOLUTION=0 keeps it off — the member override wins", async () => {
    process.env[UMBRELLA] = "1";
    process.env[FLAG] = "0";
    const result = await pack(makeWorkspace(), query, paths);
    expect(result.missing).toContain("web/order.js");
    expect(surfaceFor(result, "web/scripts/order.js")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — a caller-named FILE path that does not exist.
// ---------------------------------------------------------------------------

describe("rule 1 — guessed file paths resolve to the unique same-basename file", () => {
  it("ON: a unique basename is seeded as if the caller had spelled it, and discloses what it stands in for", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), "Explain how an order is submitted", [
      { path: "web/order.js", purpose: "order submission" },
    ]);
    const served = surfaceFor(result, "web/scripts/order.js");
    expect(served).toBeDefined();
    expect(served!.code).toContain("submitOrder");
    // The caller's own `purpose` survives, and the inference is disclosed
    // BEFORE the provenance token rather than after it.
    expect(served!.why).toContain("order submission");
    expect(served!.why).toContain("resolved-from:web/order.js");
    expect(result.missing).not.toContain("web/order.js");
  });

  it("ON: several same-basename files resolve only through the named path's OWN parent subtree", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), "Explain how the cart is emptied", [
      { path: "web/cart.js", purpose: "cart emptying" },
    ]);
    expect(surfaceFor(result, "web/scripts/cart.js")).toBeDefined();
    expect(surfaceFor(result, "vendor/cart.js")).toBeUndefined();
    expect(result.missing).not.toContain("web/cart.js");
  });

  it("ON: an ambiguous basename with no match under the named parent stays missing — no guess", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), "Explain the shared utility helpers", [
      { path: "src/util.js", purpose: "shared helpers" },
    ]);
    expect(result.missing).toContain("src/util.js");
    expect(surfaceFor(result, "lib/util.js")).toBeUndefined();
    expect(surfaceFor(result, "tools/util.js")).toBeUndefined();
  });

  it("ON: a path that EXISTS is served exactly as before — never re-pointed, never marked resolved", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), "Explain the api call helper", [
      { path: "web/scripts/api.js", purpose: "api calls" },
    ]);
    const served = surfaceFor(result, "web/scripts/api.js");
    expect(served).toBeDefined();
    expect(served!.why).not.toContain("resolved-from:");
    expect(result.missing).not.toContain("web/scripts/api.js");
  });

  it("ON: a range the resolved file cannot honor is reported as the caller wrote it", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), "Explain how an order is submitted", [
      { path: "web/order.js", range: "900-950" },
    ]);
    expect(result.missing).toContain("web/order.js");
    expect(surfaceFor(result, "web/scripts/order.js")).toBeUndefined();
  });

  it("ON: a symbol the resolved file does not define is reported as the caller wrote it", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), "Explain how an order is submitted", [
      { path: "web/order.js", symbol: "cancelEverything" },
    ]);
    expect(result.missing).toContain("web/order.js");
    expect(surfaceFor(result, "web/scripts/order.js")).toBeUndefined();
  });

  it("OFF: every one of those calls reports the guessed path as missing (today's behaviour)", async () => {
    const workspace = makeWorkspace();
    const result = await pack(workspace, "Explain how an order is submitted", [
      { path: "web/order.js", purpose: "order submission" },
      { path: "web/cart.js", purpose: "cart emptying" },
    ]);
    expect(result.missing).toContain("web/order.js");
    expect(result.missing).toContain("web/cart.js");
    expect(result.surfaces.every((surface) => surface.why?.includes("resolved-from:") !== true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — a caller-named DIRECTORY contributes locate evidence.
// ---------------------------------------------------------------------------

describe("rule 2 — a caller-named directory contributes evidence", () => {
  const targets: PackEntry[] = [
    { path: "web/scripts/api.js", purpose: "api calls" },
    { path: "services", purpose: "refund, stock release and purchase cancellation" },
  ];

  it("ON: the directory's own purpose draws bounded evidence out of it", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), SERVICE_QUERY, targets);
    const contributed = surfacesUnder(result, "services");
    // One contribution per concern the caller-named FILE does not answer --
    // and the fourth module in the directory, which answers none of them, is
    // not dragged along.
    expect(contributed.map((surface) => surface.path)).toEqual([
      "services/refundLedger.ts",
      "services/stockKeeper.ts",
      "services/purchaseFlow.ts",
    ]);
    // WP-P2 C (2026-09-20): the clause locate narrows every pick to ONE symbol
    // window because that is what makes it addressable to the picker, but a
    // file small enough to serve WHOLE is served whole -- the narrowing saves
    // nothing there and costs the caller the rest of the file (measured: an
    // 8-line endpoint window out of an 80-line controller, re-requested).
    // Either way the function that answers the clause is in the body, and the
    // `why` still names the symbol the pick was made on.
    for (const [rel, fn] of [
      ["services/refundLedger.ts", "refundPayment"],
      ["services/stockKeeper.ts", "releaseStock"],
      ["services/purchaseFlow.ts", "cancelPurchase"],
    ] as const) {
      const surface = contributed.find((candidate) => candidate.path === rel)!;
      expect(surface.code ?? "").toContain(fn);
      expect(surface.why ?? "").toContain(fn);
    }
    expect(contributed.length).toBeLessThanOrEqual(3);
    // Every contribution carries a real body, not a bare handle.
    expect(contributed.every((surface) => (surface.code ?? "").length > 0)).toBe(true);
    // The caller's own named FILE is still there, unmoved: additions are
    // appended, never a replacement or a reorder.
    expect(result.surfaces[0]!.path).toBe("web/scripts/api.js");
    expect(result.missing).not.toContain("services/ (directory)");
  });

  it("ON: a Japanese purpose reaches the same evidence through the query bridge", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), "返金と在庫の解放について説明してください。", [
      { path: "web/scripts/api.js", purpose: "api calls" },
      { path: "services", purpose: "返金と在庫解放" },
    ]);
    const contributed = surfacesUnder(result, "services");
    // The clause text shares no lexical token with this workspace, so the
    // bridge's own expansions ("refund", "stock", ...) are the only thing that
    // can reach the module -- see `jaBridgeRecoveryQuery`.
    expect(contributed.map((surface) => surface.path)).toContain("services/refundLedger.ts");
    expect(contributed.length).toBeLessThanOrEqual(3);
  });

  it("ON: a directory whose locate abstains contributes nothing, and still says so", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), SERVICE_QUERY, [
      { path: "web/scripts/api.js", purpose: "api calls" },
      { path: "vendor/shims", purpose: "third-party compression shims" },
    ]);
    expect(surfacesUnder(result, "vendor/shims")).toHaveLength(0);
    expect(result.missing).toContain("vendor/shims/ (directory)");
  });

  it("ON: a qref replay does not re-run it — the caller already holds the working set", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), SERVICE_QUERY, targets, "answer", {
      taskQueryRefReplay: true,
    });
    expect(surfacesUnder(result, "services")).toHaveLength(0);
  });

  it("ON: a CHANGE (generic) pack is untouched — readiness and obligations stay as they are", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(), SERVICE_QUERY, targets, "generic");
    const control = await pack(makeWorkspace(), SERVICE_QUERY, targets, "generic");
    expect(result.surfaces.map((surface) => surface.path))
      .toEqual(control.surfaces.map((surface) => surface.path));
  });

  it("OFF: the same directory contributes nothing (today's behaviour)", async () => {
    const result = await pack(makeWorkspace(), SERVICE_QUERY, targets);
    expect(surfacesUnder(result, "services")).toHaveLength(0);
  });
});
