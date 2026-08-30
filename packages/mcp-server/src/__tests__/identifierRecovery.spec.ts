/**
 * identifierRecovery.spec.ts — wave 4 C-1 (2026-07-24 live-canary forensics).
 *
 * An answer task_pack whose query literally names an identifier that exists in
 * the workspace used to serve unrelated candidates (`confirm_candidates`) with
 * `unresolved: ["identifier:<name>"]` — knowingly routing the model into the
 * exact literal search (`search_files action=find <name>`) the server can run
 * itself. Live reproduction: query "How does applyPackDedupe deduplicate
 * surfaces…" served persistPackFingerprints + two unrelated files while the
 * definition sat 30 lines above the served range.
 *
 * Pins:
 *   1. literal self-recovery: the definition file/range is served as an
 *      exact-identifier surface, with real code containing the identifier,
 *      and the route does NOT manufacture a confirm_candidates round trip.
 *   2. verified absence: an identifier with zero literal occurrences keeps
 *      the honest candidate flow but the readiness obligation upgrades to
 *      decision-grade "verified absent" wording.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTaskPack,
  buildTaskExecutionContract,
  type TaskPackResult,
} from "../tools/readCodeTaskPack.js";
import { handleTable } from "../util/handles.js";
import { resetAll } from "../util/session.js";

const roots: string[] = [];

function mkWorkspace(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-identrec-")));
  roots.push(root);
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** Decoy service file: rich in the query's prose terms, no target identifier. */
const DECOY = [
  "// orders service — deduplicate response surfaces for the storefront.",
  "export function dedupeResponses(surfaces: string[]): string[] {",
  "  // deduplicate surfaces in responses by identity.",
  "  const seen = new Set<string>();",
  "  return surfaces.filter((surface) => {",
  "    if (seen.has(surface)) return false;",
  "    seen.add(surface);",
  "    return true;",
  "  });",
  "}",
  "export function surfacesForResponse(): string[] {",
  "  return [\"a\", \"b\"];",
  "}",
].join("\n") + "\n";

/** Target file: holds ONLY the named identifier, none of the prose terms. */
const TARGET = [
  "const registry = new Map<string, number>();",
  "",
  "export function frobnicateWidgets(input: readonly string[]): string[] {",
  "  const out: string[] = [];",
  "  for (const item of input) {",
  "    if (!registry.has(item)) {",
  "      registry.set(item, out.push(item));",
  "    }",
  "  }",
  "  return out;",
  "}",
].join("\n") + "\n";

beforeEach(() => {
  resetAll();
  handleTable.reset();
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("explicit-identifier literal self-recovery (wave 4 C-1)", () => {
  it("serves the literal definition instead of manufacturing a confirm_candidates round trip", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/service/orders.ts", DECOY);
    writeFile(ws, "src/util/deep.ts", TARGET);

    const result: TaskPackResult = await buildTaskPack(
      // taskProfile declared: C-1 literal recovery is an answer-profile
      // feature, and §14 (2026-07-25) no longer infers "answer" from wording.
      { query: "How does frobnicateWidgets deduplicate response surfaces?", taskProfile: "answer" },
      ws,
    );

    const surfaces = result.surfaces as Array<{ path: string; code?: string; symbol?: string }>;
    const recovered = surfaces.find((surface) => surface.path === "src/util/deep.ts");
    expect(recovered, "definition file must be served as a surface").toBeDefined();
    expect(recovered!.code ?? "").toContain("frobnicateWidgets");
    expect(result.route?.action).not.toBe("confirm_candidates");

    const contract = buildTaskExecutionContract(result, "answer", "How does frobnicateWidgets deduplicate response surfaces?");
    const identifierObligation = contract.readiness_certificate?.obligations.find(
      (obligation) => obligation.id === "identifier:frobnicateWidgets",
    );
    expect(identifierObligation?.status).toBe("proved");
  });

  it("reports verified absence for an identifier with zero literal occurrences", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/service/orders.ts", DECOY);

    const query = "How does zorblatQuux deduplicate response surfaces?";
    const result: TaskPackResult = await buildTaskPack({ query, taskProfile: "answer" }, ws);

    const surfaces = result.surfaces as Array<{ path: string; code?: string }>;
    expect(surfaces.every((surface) => !(surface.code ?? "").includes("zorblatQuux"))).toBe(true);

    const contract = buildTaskExecutionContract(result, "answer", query);
    // A non-ready contract carries no readiness_certificate; the obligation
    // wording rides the wire via evidence_model.claims.
    const claim = contract.evidence_model?.claims.find(
      (entry) => entry.id === "identifier:zorblatQuux",
    );
    expect(claim?.status).toBe("supported");
    expect(claim?.reason).toContain("verified absent");
  });
});
