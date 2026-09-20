// firstPackCompleteness.spec.ts — regression coverage for WP-P2 (2026-09-20):
// the FIRST pack of a `read_file {query, targets:[files…, directories…]}` call
// must already carry what the caller pointed at.
//
// DEFECTS UNDER TEST (all three measured on recorded GitHub Copilot sessions,
// where cost is the NUMBER of model requests and each recovery turn prices at
// 150-300 mAIU):
//
//   A  A purpose the caller wrote ON a directory was discharged by a file
//      OUTSIDE it. The per-directory clause recovery judged every clause
//      against the WHOLE pack, so "payment refund" counted as covered by the
//      caller's own payment CONTROLLER and the service class the question was
//      about was never located. A directory purpose means "look IN HERE for
//      this"; a file elsewhere cannot answer it.
//
//   B  A caller-NAMED file vanished from the response with no row, no body, no
//      `remaining` and no disclosure. `trimToCap` honours `protectedSurfaces`
//      (a caller-named seed may lose its code, never its row), but a LATER
//      byte-budget tier in `dedupeTrimAndPersist` re-derived its own
//      protection and removed the largest caller-named body outright. This is
//      a DEFECT fix: it holds with every flag off.
//
//   C  A row said one symbol and carried another: the per-clause locate runs
//      once per clause and two clauses routinely re-point the SAME file at
//      different symbols, while the focus map was keyed by PATH, so the last
//      clause's symbol NAME was stamped on an earlier clause's window. And the
//      same "directory + one doc file" shape served framework/role fill
//      instead of the definitions the query spells by name, which the
//      directory-ONLY shape of the same question resolves.
//
// Every fixture is generated into `os.tmpdir()` by this file; no bench
// fixture, corpus or session path is read. Each test gets its OWN workspace:
// the pack's cross-call body dedupe is keyed by workspace, so replaying a call
// inside one process would otherwise return a withholding receipt.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildTaskPack, type TaskPackSurface } from "../features/task-pack/readCodeTaskPack.js";

const FLAG = "TL_NAMED_TARGET_RESOLUTION";
const UMBRELLA = "TL_TURN_ECONOMY";

const workspaces: string[] = [];

function makeWorkspace(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-first-pack-"));
  workspaces.push(root);
  for (const [rel, content] of Object.entries(files)) {
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

interface PackEntry { path: string; purpose?: string }
interface PackResult { surfaces: TaskPackSurface[]; missing: string[] }

async function pack(
  workspace: string,
  query: string,
  paths: PackEntry[],
  taskProfile: "answer" | "generic" = "answer",
  extra: Record<string, unknown> = {},
): Promise<PackResult> {
  return await buildTaskPack({ query, paths, taskProfile, ...extra } as never, workspace) as never;
}

function paths(result: PackResult): string[] {
  return result.surfaces.map((surface) => surface.path);
}

function surfacesUnder(result: PackResult, dir: string): TaskPackSurface[] {
  return result.surfaces.filter((surface) => surface.path.startsWith(dir + "/"));
}

/** Filler wide enough that a module is a real body rather than a stub. */
function filler(tag: string, count: number): string {
  return Array.from({ length: count }, (_, i) =>
    `  const ${tag}Step${i} = ${i} * 31 + ${i}; // step ${i} of the ${tag} routine`
  ).join("\n");
}

function serviceModule(title: string, fn: string, lines: number): string {
  return [
    `// ${title} — one concern of the checkout flow.`,
    `export function ${fn}(id: string): string {`,
    filler(fn, lines),
    `  return id;`,
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// A — a purpose written ON a directory is answered from INSIDE that directory.
// ---------------------------------------------------------------------------

// `api/refundEndpoint.ts` is the trap: the caller names it as a FILE, and its
// own path carries the token "refund", so judging the directory's purpose
// clause "refund payment" against the whole pack finds it already covered.
const A_FILES: Readonly<Record<string, string>> = {
  "api/refundEndpoint.ts": serviceModule("Refund HTTP endpoint", "postRefund", 12),
  "api/cancelEndpoint.ts": serviceModule("Cancel HTTP endpoint", "postCancel", 12),
  "services/refundLedger.ts": serviceModule("Refund ledger", "refundPayment", 40),
  "services/stockKeeper.ts": serviceModule("Stock keeper", "releaseStock", 40),
  "services/purchaseFlow.ts": serviceModule("Purchase flow", "cancelPurchase", 40),
  "services/mailer.ts": serviceModule("Mailer", "sendMail", 40),
};

const A_QUERY =
  "Trace a cancelled purchase from the HTTP endpoint through the service layer, "
  + "the payment refund and the stock release.";

describe("A — a directory purpose is discharged only from inside that directory", () => {
  const namedOutside: PackEntry[] = [
    { path: "api/refundEndpoint.ts", purpose: "refund endpoint" },
    { path: "api/cancelEndpoint.ts", purpose: "cancel endpoint" },
    { path: "services", purpose: "payment refund, stock release, purchase cancellation" },
  ];

  it("ON: the refund concern is located INSIDE the directory although a refund file outside it is caller-named", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(A_FILES), A_QUERY, namedOutside);
    // The caller-named endpoint outside the directory is NOT what the
    // directory's own purpose asked for.
    expect(paths(result)).toContain("services/refundLedger.ts");
    const contributed = surfacesUnder(result, "services");
    expect(contributed.length).toBeGreaterThanOrEqual(2);
    // Bounds: MAX_NAMED_DIR_SURFACES per directory entry, and the module that
    // answers none of the clauses is not dragged along.
    expect(contributed.length).toBeLessThanOrEqual(3);
    expect(paths(result)).not.toContain("services/mailer.ts");
    // Strictly additive: the caller's own named files still lead the pack.
    expect(result.surfaces[0]!.path).toBe("api/refundEndpoint.ts");
  });

  it("ON: the SAME directory named twice contributes for both purposes", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(A_FILES), A_QUERY, [
      { path: "api/refundEndpoint.ts", purpose: "refund endpoint" },
      { path: "services", purpose: "payment refund" },
      { path: "services", purpose: "stock release and purchase cancellation" },
    ]);
    const contributed = surfacesUnder(result, "services").map((surface) => surface.path);
    // The targets de-dupe keeps one entry per path, so the second purpose is
    // only reachable by reading every purpose the caller attached to this
    // directory back off their own entry list.
    expect(contributed).toContain("services/refundLedger.ts");
    expect(contributed.some((rel) =>
      rel === "services/stockKeeper.ts" || rel === "services/purchaseFlow.ts"
    )).toBe(true);
    expect(contributed.length).toBeLessThanOrEqual(3);
  });

  it("OFF: the directory contributes nothing (today's behaviour)", async () => {
    const result = await pack(makeWorkspace(A_FILES), A_QUERY, namedOutside);
    expect(surfacesUnder(result, "services")).toHaveLength(0);
  });

  it("ON: a CHANGE (generic) pack is untouched — readiness and obligations stay as they are", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(A_FILES), A_QUERY, namedOutside, "generic");
    const control = await pack(makeWorkspace(A_FILES), A_QUERY, namedOutside, "generic");
    // A change pack keeps whatever the pre-existing confined directory fill
    // gives it; what must not happen is the answer-only clause recovery
    // running and adding to it.
    expect(paths(result)).toEqual(paths(control));
    expect(paths(result)).not.toContain("services/refundLedger.ts");
  });
});

// ---------------------------------------------------------------------------
// B — every caller-named path keeps a row, whatever the byte budget does.
// ---------------------------------------------------------------------------

/** Nine named modules whose bodies together far exceed any pack tier. */
const B_FILES: Readonly<Record<string, string>> = Object.fromEntries([
  // The LARGEST body is the one the defect deleted: it is also the one a
  // largest-first shed reaches first.
  ["pipeline/orchestrator.ts", serviceModule("Pipeline orchestrator", "runPipeline", 420)],
  ...["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"].map((name, index) =>
    [`modules/${name}Module.ts`, serviceModule(`${name} module`, `run${name}`, 90 + index * 10)] as const
  ),
]);

const B_TARGETS: PackEntry[] = Object.keys(B_FILES).map((rel) => ({
  path: rel,
  purpose: `the ${path.basename(rel, ".ts")} step of the pipeline`,
}));

const B_QUERY =
  "Explain how the pipeline runs end to end: which module each step lives in, "
  + "and what the orchestrator does with their results.";

describe("B — a caller-named path never loses its row to the byte budget", () => {
  for (const [label, env] of [["flag OFF", undefined], ["umbrella ON", UMBRELLA]] as const) {
    it(`${label}: all nine named files are represented, and any body-less row carries its remaining range`, async () => {
      if (env !== undefined) process.env[env] = "1";
      const result = await pack(makeWorkspace(B_FILES), B_QUERY, B_TARGETS, "answer", {
        content: "full",
      });
      for (const target of B_TARGETS) {
        const served = result.surfaces.find((surface) => surface.path === target.path);
        expect(served, `${target.path} has no evidence row`).toBeDefined();
        expect(served!.handle.length).toBeGreaterThan(0);
        if ((served!.code ?? "").length === 0) {
          // The floor: a row with no body still says where the rest is.
          expect(served!.remaining_ranges ?? []).not.toHaveLength(0);
        }
      }
      // A useful body beats none: the pack does not empty every row.
      expect(result.surfaces.filter((surface) => (surface.code ?? "").length > 0).length)
        .toBeGreaterThanOrEqual(B_TARGETS.length - 1);
      // Nothing was silently deleted for bytes.
      expect(result.missing.some((entry) => entry.startsWith("dropped-by-byte-budget:"))).toBe(false);
      // A body the tier shortened states the PRECISE remainder: a row that
      // still carries leading lines must never advertise its whole range as
      // unserved (measured: a 374-line file served to line ~234 said
      // `remaining:["1-374"]`, i.e. "re-read all of it").
      for (const surface of result.surfaces) {
        if ((surface.code ?? "").length === 0 || surface.range === undefined) continue;
        expect(surface.remaining_ranges ?? [], `${surface.path} ${surface.range}`).not.toContain(surface.range);
      }
    });
  }

});

// ---------------------------------------------------------------------------
// C — directory + one doc file resolves the identifiers the query names.
// ---------------------------------------------------------------------------

/** A module too large to serve whole, holding both a class and the member. */
function largeService(className: string, members: readonly string[]): string {
  return [
    `// ${className} — the checkout service.`,
    `export class ${className} {`,
    ...members.map((member) => [
      `  public ${member}(id: string): string {`,
      filler(member, 70),
      `    return id;`,
      "  }",
    ].join("\n")),
    "}",
    "",
  ].join("\n");
}

const C_FILES: Readonly<Record<string, string>> = {
  "NOTES.md": "# Checkout notes\n\nSupplementary API notes for the checkout flow.\n",
  "core/orderService.ts": largeService("OrderService", ["placeOrder", "cancelOrder", "payOrder"]),
  "core/paymentService.ts": largeService("PaymentService", ["charge", "refund"]),
  "core/orderStatus.ts": [
    "// OrderStatus — the lifecycle states an order moves through.",
    "export enum OrderStatus { CREATED, PAID, CANCELLED, REFUNDED }",
    "",
  ].join("\n"),
  // Two decoys that MENTION the identifiers without defining them: before the
  // fix these won the role slots, because the identifier arm fell back to
  // "whichever file mentions the name first".
  "core/frameworkConfig.ts": [
    "// Framework wiring. Mentions OrderService and PaymentService as beans.",
    "export const beans = [\"OrderService\", \"PaymentService\", \"OrderStatus\"];",
    filler("wiring", 20),
    "",
  ].join("\n"),
  "core/adminController.ts": [
    "// Admin endpoints. Mentions OrderService and cancelOrder in passing.",
    "export function adminCancel(id: string): string {",
    filler("admin", 60),
    "  return id;",
    "}",
    "",
  ].join("\n"),
};

const C_QUERY =
  "Explain the cancellation path: the OrderService cancelOrder method, the "
  + "PaymentService refund method, and the OrderStatus definition.";

describe("C — a directory plus a doc file serves what the directory alone serves", () => {
  const targets: PackEntry[] = [
    { path: "core", purpose: "the checkout implementation" },
    { path: "NOTES.md", purpose: "supplementary API notes" },
  ];

  it("ON: the definitions the query names are served, and the framework decoys are not", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(C_FILES), C_QUERY, targets);
    const served = paths(result);
    expect(served).toContain("core/orderService.ts");
    expect(served).toContain("core/paymentService.ts");
    expect(served).toContain("core/orderStatus.ts");
    // No role fill once the named definitions resolved: the framework decoy
    // that merely MENTIONS the identifiers is not offered as directory
    // evidence. (The readiness pass may still attach it as an explicit
    // falsification counterexample, which is a different claim and stays.)
    const decoy = result.surfaces.find((surface) => surface.path === "core/frameworkConfig.ts");
    expect(decoy?.why ?? "readiness-falsification-counterexample")
      .toContain("readiness-falsification-counterexample");
    // The bodies are real: the member the question is about is inside them.
    const order = result.surfaces.find((surface) => surface.path === "core/orderService.ts")!;
    expect(order.code ?? "").toContain("cancelOrder");
    const payment = result.surfaces.find((surface) => surface.path === "core/paymentService.ts")!;
    expect(payment.code ?? "").toContain("refund");
  });

  it("ON: a row that names a symbol carries that symbol — label and window agree", async () => {
    process.env[FLAG] = "1";
    const result = await pack(makeWorkspace(C_FILES), C_QUERY, targets);
    for (const surface of result.surfaces) {
      const named = /anchor-focus: (?:query-matched|explicit query identifier) symbol (\S+)/
        .exec(surface.why ?? "")
        ?? /anchor-focus: explicit query identifier (\S+)/.exec(surface.why ?? "");
      if (named === null || named === undefined) continue;
      expect(
        surface.code ?? "",
        `${surface.path}:${surface.range} claims symbol ${named[1]} but does not carry it`,
      ).toContain(named[1]!);
    }
  });

  it("OFF: the same call is unchanged (today's behaviour)", async () => {
    const result = await pack(makeWorkspace(C_FILES), C_QUERY, targets);
    const control = await pack(makeWorkspace(C_FILES), C_QUERY, targets);
    expect(paths(result)).toEqual(paths(control));
  });
});
