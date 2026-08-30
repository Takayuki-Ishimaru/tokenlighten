/**
 * receiptStaleNextBrake.spec.ts — F-V13-5 (v0.13.0 external verification, P0-A).
 *
 * THE INCIDENT. A caller re-sent one query and received the SAME
 * `search_files` `next` seven times running, after having executed that search
 * on the first turn. Every re-send produced zero progress and zero new bytes.
 *
 * THE CAUSE, and why the existing brakes did not fire. The FRESH-BUILD path
 * has had the right machinery since 2026-08-28: the dispatcher records every
 * executed search, `suppressNonProgressingNextCall` consults that ledger, and
 * `repairSuppressedNextCall` either finds an alternative progress axis or
 * discloses an honest gap. None of it is reachable from the RECEIPT paths.
 * `tryServeCachedPack` / `tryServeSemanticDuplicatePack` short-circuit inside
 * `buildTaskPack` BEFORE the builder runs, keyed on `computePackFingerprint`
 * — a hash of the REQUEST, which is byte-identical across the re-send and
 * therefore cannot see the execution that happened between the two calls. The
 * compact receipt then replays the contract captured BEFORE its own next_call
 * ran, and `compactReceiptFromRecord` re-validates only
 * `LOCATE_ONLY_NO_REPEAT_ACTIONS` (deliberately — see its comment). So for
 * find/references/tree a receipt re-proposed consumed work indefinitely.
 *
 * Note the receipt does not have to reach the wire as `read.receipt` for the
 * loop to bite: a compact receipt whose decision is `discover`/`await_input`
 * is re-projected as `read.task_pack`, carrying the stale `next` with it.
 * These tests therefore assert on `decision.next`, not on `kind`.
 *
 * AND NOTE WHAT THE FIX IS NOT. The wire already filters a consumed candidate
 * out of its own precedence chain (`projectTaskDecision`'s `firstUnconsumed`),
 * so a next executed VERBATIM is handled there and the receipt must be left
 * alone — dropping it would replace a progressing continuation with a bare
 * terminus, which sequenceCorpus's I5 invariant catches. The gap is narrower:
 * that filter is a whole-call fingerprint, so a call executed under a
 * different argument SPELLING than the contract proposed (`references
 * scope.symbol=X` vs a proposed `references query=X`) is invisible to it. The
 * `references` case below is exactly that shape.
 *
 * WHAT IS PINNED: the second half of the loop cannot happen — once the
 * prescribed search has actually run, the same request never hands that search
 * back. Plus the negative control that keeps this from being vacuous: while
 * the search is still UNEXECUTED, the same fixture keeps re-proposing it, so
 * the assertions are measuring the executed-work ledger and not some unrelated
 * disappearance of the next.
 *
 * VERIFIED FAIL-FIRST, and honestly scoped: with the brake short-circuited to
 * `false`, exactly ONE of these six goes red — the `references` case. That is
 * the direct pre-fix reproduction. The `find` and `qref` cases below pass
 * either way (their packs are repaired on the fresh-build path before a
 * receipt can be minted for them); they are kept as coverage of the two OTHER
 * doors into the same record, not as evidence of the defect.
 *
 * MKDTEMP UNDER $HOME, NOT `os.tmpdir()`: the vitest env pins
 * `TOKENLIGHTEN_ALLOWED_PARENTS` to `os.homedir()`, so a `/var/folders/…` root
 * is refused `invalid-cwd` before a pack is ever built. Same hidden-`.tl-`
 * convention as laneIsolationPacks.spec.ts and replayCorpus.spec.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/**
 * One served implementation file plus an unrelated doc. Small enough that the
 * seeded surface always serves whole (so the record is receipt-eligible: a
 * zero-`fileShas` capture can never be re-served compactly) while the query
 * still names a collaborator that exists nowhere — which is what keeps the
 * contract in discovery with a search-shaped `next_call`.
 */
function makeWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-stale-next-${tag}-`)));
  roots.push(root);
  writeFile(root, "package.json", JSON.stringify({ name: `stale-${tag}` }) + "\n");
  writeFile(root, "src/alpha.ts", [
    "export function alphaTotal(amount: number): number {",
    "  return amount * 2;",
    "}",
  ].join("\n") + "\n");
  writeFile(root, "src/beta.ts", [
    "export function betaTotal(amount: number): number {",
    "  return amount * 3;",
    "}",
  ].join("\n") + "\n");
  writeFile(root, "docs/notes.md", "# notes\n\nNothing relevant here.\n");
  return root;
}

interface ToolResult { content: Array<{ text: string }> }
type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

let callTool: CallTool;

beforeAll(async () => {
  ({ callTool } = await import("../server.js") as unknown as { callTool: CallTool });
});

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** The one executable call a response puts on the wire, if any. */
function nextOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const decision = body["decision"] as Record<string, unknown> | undefined;
  const next = decision?.["next"];
  return next !== null && typeof next === "object" ? next as Record<string, unknown> : undefined;
}

/** Does the emitted `next` name this search_files action over this term? */
function proposesSearch(body: Record<string, unknown>, action: string, term: string): boolean {
  const next = nextOf(body);
  if (next === undefined || next["tool"] !== "search_files") return false;
  const args = JSON.stringify(next["arguments"] ?? {});
  return args.includes(`"${action}"`) && args.includes(term);
}

// Two independent producers of a search-shaped `next_call` over a served pack:
// the wiring profile's producer probe (`find`, singular `query`) and its
// consumer probe (`references`). Both are captured onto the served-pack record,
// which is exactly what a later receipt replays.
const WIRING_FIND = {
  tag: "find",
  query: "wire `courierWebhook` into alphaTotal so the multiplier is applied",
  action: "find",
  term: "courierWebhook",
  // The shape an agent executing that prescription actually sends.
  run: { action: "find", queries: ["courierWebhook"] },
} as const;
const WIRING_REFERENCES = {
  tag: "references",
  query: "connect the courier webhook producer to the alphaTotal consumer",
  action: "references",
  term: "alphaTotal",
  run: { action: "references", scope: { symbol: "alphaTotal" } },
} as const;

describe("F-V13-5: a receipt never replays a search this session already ran", () => {
  for (const shape of [WIRING_FIND, WIRING_REFERENCES]) {
    it(`re-asking after running the prescribed ${shape.tag} does not hand the same ${shape.tag} back`, async () => {
      const ws = makeWorkspace(`ran-${shape.tag}`);
      const request = {
        query: shape.query,
        targets: [{ path: "src/alpha.ts" }],
        task: { profile: "generic" },
        cwd: ws,
      };

      const first = await call("read_file", request);
      expect(first["kind"]).toBe("read.task_pack");
      // Precondition of the whole test: the pack really did prescribe it.
      expect(proposesSearch(first, shape.action, shape.term)).toBe(true);

      // The caller does exactly as told. The dispatcher books it as consumed
      // work in both ledgers the brake reads.
      const ran = await call("search_files", { ...shape.run, cwd: ws });
      expect(String(ran["kind"])).toContain("search.");

      // The byte-identical re-ask. Pre-fix this short-circuited on the request
      // fingerprint into a compact receipt that replayed the very call just
      // executed — turn 3 of 7 in the observed loop.
      const second = await call("read_file", request);
      expect(proposesSearch(second, shape.action, shape.term)).toBe(false);

      // And it stays closed: a third re-ask must not resurrect it either.
      const third = await call("read_file", request);
      expect(proposesSearch(third, shape.action, shape.term)).toBe(false);
    });

    it(`still re-proposes the ${shape.tag} while it is UNEXECUTED (the receipt economy is not broken)`, async () => {
      const ws = makeWorkspace(`kept-${shape.tag}`);
      const request = {
        query: shape.query,
        targets: [{ path: "src/alpha.ts" }],
        task: { profile: "generic" },
        cwd: ws,
      };

      const first = await call("read_file", request);
      expect(proposesSearch(first, shape.action, shape.term)).toBe(true);

      // No search runs in between. The prescription is still owed, so the
      // re-ask must keep naming it — this is what makes the assertions in the
      // test above measure the executed-work ledger and nothing else.
      const second = await call("read_file", request);
      expect(proposesSearch(second, shape.action, shape.term)).toBe(true);
    });
  }

  it("the qref replay of a consumed search is closed too", async () => {
    const ws = makeWorkspace("qref");
    const request = {
      query: WIRING_REFERENCES.query,
      targets: [{ path: "src/alpha.ts" }],
      task: { profile: "generic" },
      cwd: ws,
    };
    const first = await call("read_file", request);
    const qref = first["qref"];
    expect(typeof qref).toBe("string");
    expect(proposesSearch(first, "references", "alphaTotal")).toBe(true);

    await call("search_files", { ...WIRING_REFERENCES.run, cwd: ws });

    // A qref re-pack is the OTHER door into the same record — the one D3's
    // original receipt-staleness note was written against.
    const replay = await call("read_file", { qref, cwd: ws });
    expect(proposesSearch(replay, "references", "alphaTotal")).toBe(false);
  });

  it("a read/zoom receipt is untouched by the search brake (the guard is action-scoped)", async () => {
    // A plain answer pack over one small file: its record carries no search
    // next at all, so the brake must be invisible here and the compact
    // `pack-unchanged` receipt must still be served on the identical re-ask.
    const ws = makeWorkspace("zoom");
    const request = {
      query: "explain how alphaTotal computes the multiplier",
      targets: [{ path: "src/alpha.ts" }],
      task: { profile: "answer" },
      cwd: ws,
    };
    const first = await call("read_file", request);
    expect(first["kind"]).toBe("read.task_pack");
    const second = await call("read_file", request);
    expect(second["kind"]).toBe("read.receipt");
  });
});
