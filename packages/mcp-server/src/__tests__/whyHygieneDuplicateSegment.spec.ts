import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";

// ---------------------------------------------------------------------------
// P2 (2026-09-27 evaluation §6.3, "少数の観察に基づく補助的な改善点" — the
// evidence-originality neighbor finding). CONFIRMED LIVE on this tree
// (2026-09-27), reproduced through the ordinary wire path with no fixture or
// benchmark-specific identifier: a single-file, explicit `taskProfile:
// "generic"` pack serves `evidence[0].why === "caller-supplied;
// caller-supplied"` — an identical `; `-separated segment repeated once.
//
// GENERAL RULE THIS PINS: a surface's `why` must never repeat an identical
// `; `-separated segment, for ANY reason string the server composes it from
// — this is a hygiene property of the joiner, not a fact about "caller-
// supplied" specifically, and holds for every language TokenLighten reads.
//
// ROOT CAUSE (confirmed by reading AND fixed, 2026-09-27 INT-A): the `why`
// string is composed entirely inside `features/task-pack/readCodeTaskPack.ts`.
// `buildSeededTaskPack`'s default per-path stamp for a plain caller-named seed
// (no `purpose`, not NUL-stripped, not an executed-search promotion) is
// correctly the BARE marker `"caller-supplied"` — that IS the whole fact for
// that seed. `candidateToSurface` then re-stamped provenance: it checked
// `surfaceWhyHasMarker(candidate.why, "caller-supplied")` — true here — and
// unconditionally appended "; caller-supplied" again, producing
// "caller-supplied; caller-supplied". `features/task-pack/model.ts`'s own doc
// comment on `executedSearchLocated` (~line 719, "R1-B2") already named this
// exact duplicate string as a defect class, closed there for ONE producer
// path (an executed-search-located seed is stamped `executed-search-located`
// instead of the plain default) — but the plain explicit-profile `paths` seed
// this spec drives never went through that promotion, so it still hit the
// same join-time bug one layer downstream, in `candidateToSurface` itself.
//
// FIX: a single general join primitive, `appendWhySegmentOnce(why, marker)`
// (readCodeTaskPack.ts, beside `whyWithQualifier`) — appends `marker` as a
// new `; `-separated segment only when `why` does not already END with that
// exact segment. Used at every site in that file which conditionally appends
// a trailing provenance marker onto an already-composed `why`
// (`candidateToSurface`'s caller-supplied/qualifier joins, the anchor-focus
// re-stamp, `whyWithQualifier`'s own fallback) — one rule, not a
// "caller-supplied"-specific patch, so it holds for any reason string the
// server composes this way, in any language TokenLighten reads.
// ---------------------------------------------------------------------------
describe("why hygiene: no repeated ;-separated segment", () => {
  it("a single explicit-profile path seed does not double-stamp its own why", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-why-hygiene-")));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "why-hygiene", type: "module" }) + "\n");
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/worker.ts"), "export function worker() { return false; }\n");

      const response = await callTool("read_file", {
        mode: "task_pack",
        query: "worker behavior update",
        taskProfile: "generic",
        paths: ["src/worker.ts"],
        cwd: root,
      });
      const result = JSON.parse(response.content[0]!.text) as Record<string, unknown>;
      const evidence = (result["evidence"] ?? []) as Array<Record<string, unknown>>;

      for (const entry of evidence) {
        const why = typeof entry["why"] === "string" ? entry["why"] : "";
        const segments = why.split("; ");
        expect(
          new Set(segments).size,
          `evidence for ${String(entry["path"])} repeats a why segment: ${JSON.stringify(why)}`,
        ).toBe(segments.length);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
