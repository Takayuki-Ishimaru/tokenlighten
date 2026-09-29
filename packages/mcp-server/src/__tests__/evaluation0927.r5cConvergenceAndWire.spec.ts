/**
 * evaluation0927.r5cConvergenceAndWire.spec.ts — R5-C (round-5 wave,
 * 2026-09-28): regression coverage for review-findings-fable-r4.md's P1-8,
 * P1-9 and P2-12 findings (the "convergence and wire" section of the round-5
 * brief).
 *
 * Every fixture below is written FRESH against the DESCRIBED defect class —
 * different names, different files, a different language from the
 * reviewer's own harness cases (kotlinFun/tsTwoClassesSameMethod,
 * hugeFocalValue, qrefAfterCertified — `$SCRATCH/review4/cases4.mjs`) — so a
 * fix that only special-cases the reviewer's exact identifiers would still
 * fail here.
 *
 * P1-8 root cause (readCodeTaskPack.ts's `alternativeProgressAxis`, Rule 3):
 * a candidate surface with no INLINE body in the CURRENT rebuild (because the
 * wire correctly re-served it as `prior`) was treated as "never served" and
 * re-offered as a `next` forever, even once the session's served-range
 * ledger (`surfaceRangeShipped`) proved the caller already held every
 * candidate in full — the pack then cycled through re-reading each
 * already-known candidate one at a time and dead-ended on a bodyless
 * `read.receipt` with no evidence and no `next`. Fixed by gating Rule 3 on
 * the ledger, not just the in-memory self-report, so once every candidate is
 * genuinely resident this axis contributes nothing and the pack can reach
 * its own honest exit (here: a workspace-wide search resolves which
 * candidate is real, and the pack certifies `act.answer`).
 *
 * P1-9 root cause: a plain caller-ranged `{handle,range}` zoom (server.ts's
 * `mode=slice` dispatch) recorded into the session-wide served-range ledger
 * (`recordServedRange`, keyed by workspace+path+sha) but never into the
 * SEPARATE epoch+lane-scoped window ledger (`recordServedWindow`,
 * util/packServeLog.ts) that a later task-pack REBUILD's own completeness
 * check (`firstUnservedPartialRange` / `servedWindowHasUnservedLines`)
 * consults. A rebuild therefore never learned that a byte-capped focal
 * surface's tail had already been delivered by exactly this route, and kept
 * re-declaring the SAME already-delivered window as `remaining_ranges`
 * forever. Fixed by also booking the zoom into the scoped window ledger
 * (server.ts's `noteZoomServedForAnswerEpoch`), under the SAME epoch tokens
 * the existing carried-evidence booking already resolves.
 *
 * RESIDUAL (reported, not fixed here — see the round-5 report): once every
 * remaining window is genuinely delivered this way, a SEPARATE, deeper
 * self-report (`hasSufficientEditContent` / `content_sufficiency`,
 * readCodeTaskPack.ts ~24133/~45093) still never reconciles a surface's own
 * stale `content_completeness:"partial"` flag against the ledger, so full
 * convergence to `act.answer` is not guaranteed by this fix alone. This
 * spec asserts the P1-9 contract this wave DID fix — no `next` ever
 * re-targets a window already delivered — not full convergence.
 *
 * P2-12 root cause (server.ts's `inheritDeclaredTaskProfile`): the "omit
 * re-declaring `task.profile` when it would not change anything" carve-out
 * also suppressed it for `task:{force_serve:true}`, even though force_serve
 * never reaches the cache/dedup doors that carve-out protects (they are
 * unconditionally skipped under force_serve) — so a force-served rebuild of
 * a task DECLARED `task.profile:"answer"` re-derived its binding from
 * scratch and reported `requested:"auto", source:"inferred"`, silently
 * losing the caller's own declaration. Fixed by not applying that carve-out
 * under force_serve.
 *
 * Fast, no-server checks first are not applicable here (all three findings
 * are wire/decision-flow behavior, not pure-function behavior); every case
 * below is an end-to-end dev-server scenario, one describe block per
 * finding, servers stopped in `afterEach`.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  extractNext,
  followNextToEnd,
  startDevServer,
  type ChainResult,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
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

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function server(ws: string, config: "default" | "vscode" = "default"): Promise<ServerHandle> {
  const s = startDevServer(ws, config);
  servers.push(s);
  await s.initialize();
  return s;
}

// ===========================================================================
// P1-8 — an ambiguous-target choose-candidate pack converges (never a bare,
// next-less receipt), and a next never re-reads a candidate already held in
// full. Python, two classes with a same-named method — a different language
// and shape from the reviewer's Kotlin/TS repros.
// ===========================================================================
function pyAmbiguousCandidateWorkspace(): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-r5c-py-"));
  tmpDirs.push(ws);
  writeFile(ws, "pyproject.toml", "[project]\nname = \"svc\"\nversion = \"0.1.0\"\n");
  writeFile(ws, "svc/live_client.py", [
    "class RemoteStore:",
    "    def __init__(self, base_url):",
    "        self.base_url = base_url",
    "",
    "    def load_record(self, key):",
    "        return fetch(self.base_url + key)",
    "",
  ].join("\n"));
  writeFile(ws, "svc/stub_client.py", [
    "class StubStore:",
    "    def __init__(self, canned):",
    "        self.canned = canned",
    "",
    "    def load_record(self, key, override=None):",
    "        return override if override is not None else self.canned",
    "",
  ].join("\n"));
  writeFile(ws, "svc/reader.py", [
    "from .live_client import RemoteStore",
    "",
    "class RecordReader:",
    "    def __init__(self, store):",
    "        self.store = store",
    "",
    "    def read(self, key):",
    "        return self.store.load_record(key)",
    "",
  ].join("\n"));
  return ws;
}

/** Extracts every `{handle: X}`-only (no ranged sub-window) address a `next`/call names. */
function handleAddressesOf(call: { arguments?: Record<string, unknown> } | undefined): string[] {
  if (call?.arguments === undefined) return [];
  const args = call.arguments;
  const out: string[] = [];
  const targets = args["targets"];
  if (Array.isArray(targets)) {
    for (const raw of targets) {
      if (raw !== null && typeof raw === "object") {
        const t = raw as Record<string, unknown>;
        if (typeof t["handle"] === "string" && t["range"] === undefined) out.push(t["handle"]);
      }
    }
  }
  if (typeof args["handle"] === "string" && args["range"] === undefined) out.push(args["handle"]);
  return out;
}

function bodyBearingHandlesOf(response: unknown): Set<string> {
  const out = new Set<string>();
  const rec = response as Record<string, unknown> | null | undefined;
  const evidence = rec?.["evidence"];
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      if (e !== null && typeof e === "object") {
        const row = e as Record<string, unknown>;
        if (typeof row["handle"] === "string" && typeof row["body"] === "string") out.add(row["handle"]);
      }
    }
  }
  return out;
}

describe("P1-8: ambiguous-target candidate lists converge", () => {
  it("never re-reads (by bare handle) a candidate this task already holds in full, and never dead-ends on a bodyless next-less receipt", async () => {
    const ws = pyAmbiguousCandidateWorkspace();
    const s = await server(ws);
    const chain: ChainResult = await followNextToEnd(
      s,
      { tool: "read_file", arguments: { query: "Who calls load_record?", task: { epoch: "new", profile: "answer" }, cwd: ws } },
      { cwd: ws, hopCap: 12, maxQrefRepacks: 3 },
    );
    expect(chain.capped, JSON.stringify(chain.hops.map((h) => h.response?.kind))).toBe(false);

    // Track handles this chain has ever seen a BODY for; assert no LATER
    // `next` re-addresses that exact handle by a bare (rangeless) target —
    // the shape `repairSuppressedNextCall`'s Rule 3 used to keep proposing.
    const seenWithBody = new Set<string>();
    for (const hop of chain.hops) {
      const { next } = extractNext(hop.response);
      for (const handle of handleAddressesOf(next)) {
        expect(
          seenWithBody.has(handle),
          `hop ${hop.hopIndex}'s next re-reads handle ${handle}, whose body this chain already received`,
        ).toBe(false);
      }
      for (const handle of bodyBearingHandlesOf(hop.response)) seenWithBody.add(handle);
    }

    // The chain must not terminate on a bodyless, next-less, evidence-empty
    // receipt (the kotlinFun dead end) — every hop with no `next` must carry
    // either a decision or at least one evidence/content row.
    const final = chain.final;
    const finalHasNext = extractNext(final).next !== undefined;
    if (!finalHasNext) {
      const hasDecision = final?.decision !== undefined;
      const hasEvidence = Array.isArray(final?.evidence) && final.evidence.length > 0;
      const hasContent = typeof final?.content === "string";
      expect(
        hasDecision || hasEvidence || hasContent,
        `chain dead-ended on a bare receipt: ${JSON.stringify(final)}`,
      ).toBe(true);
    }

    // Real progress: the actual caller site is named somewhere in the chain.
    const chainText = JSON.stringify(chain.hops.map((h) => h.response));
    expect(chainText).toContain("self.store.load_record(key)");
  });

  it("control: a single, unambiguous same-named-callable query still reaches act.answer", async () => {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-r5c-py-ctrl-"));
    tmpDirs.push(ws);
    writeFile(ws, "pyproject.toml", "[project]\nname = \"svc\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "svc/only_client.py", [
      "class OnlyStore:",
      "    def load_record(self, key):",
      "        return key",
      "",
    ].join("\n"));
    writeFile(ws, "svc/reader.py", [
      "from .only_client import OnlyStore",
      "",
      "def read(store: OnlyStore, key):",
      "    return store.load_record(key)",
      "",
    ].join("\n"));
    const s = await server(ws);
    const chain = await followNextToEnd(
      s,
      { tool: "read_file", arguments: { query: "Who calls load_record?", task: { epoch: "new", profile: "answer" }, cwd: ws } },
      { cwd: ws, hopCap: 8 },
    );
    expect(chain.capped).toBe(false);
    expect(chain.final?.decision?.kind).toBe("act.answer");
  });
});

// ===========================================================================
// P1-9 — a caller-ranged `{handle,range}` zoom credits the served-range
// ledger a later task-pack rebuild consults: no `next` ever re-targets a
// window this task already delivered by that route. A ~150-line function
// (byte-capped at hop 0, forcing exactly this zoom shape), different names
// and a different default value from the reviewer's hugeFocalValue.
// ===========================================================================
function r5cHugeFunctionWorkspace(): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-r5c-huge-"));
  tmpDirs.push(ws);
  writeFile(ws, "package.json", '{ "name": "r5c-huge", "private": true, "type": "module" }\n');
  writeFile(ws, "src/settings.ts", "export const CONNECT_OPTIONS = {\n  timeoutMs: 8400,\n  maxAttempts: 4,\n};\n");
  let body = "import { CONNECT_OPTIONS } from \"./settings\";\n\nexport async function connectWithBackoff(target: string): Promise<Response> {\n  let attempt = 0;\n";
  for (let i = 0; i < 150; i += 1) {
    body += `  if (attempt === ${i}) { attempt += 1; console.log("backoff step ${i} for " + target); }\n`;
  }
  body += "  for (; attempt < CONNECT_OPTIONS.maxAttempts; attempt++) {\n    const response = await fetch(target, { signal: AbortSignal.timeout(CONNECT_OPTIONS.timeoutMs) });\n    if (response.ok) return response;\n  }\n  throw new Error(\"exhausted\");\n}\n";
  writeFile(ws, "src/connector.ts", body);
  return ws;
}

describe("P1-9: caller-ranged zoom windows are credited to the ledger a rebuild consults", () => {
  it("no next ever re-targets a {handle,range} window this chain already fetched", async () => {
    const ws = r5cHugeFunctionWorkspace();
    const s = await server(ws);
    const chain: ChainResult = await followNextToEnd(
      s,
      { tool: "read_file", arguments: { query: "What default timeout does connectWithBackoff use?", task: { epoch: "new", profile: "answer" }, cwd: ws } },
      { cwd: ws, hopCap: 10, maxQrefRepacks: 3 },
    );
    expect(chain.capped, JSON.stringify(chain.hops.map((h) => h.response?.kind))).toBe(false);

    // Every {handle,range} (or {path,range}) window this chain executed —
    // keyed by handle-or-path + range string, since a rebuild may re-mint a
    // fresh handle for the same path.
    const executedWindows = new Set<string>();
    const windowKey = (path_: string | undefined, handle: string | undefined, range: string | undefined): string | undefined =>
      range === undefined || (path_ === undefined && handle === undefined) ? undefined : `${path_ ?? handle}\u0000${range}`;

    for (const hop of chain.hops) {
      const args = hop.call.arguments as Record<string, unknown>;
      const targets = Array.isArray(args["targets"]) ? args["targets"] as Record<string, unknown>[] : [];
      const addressed = targets.length > 0
        ? targets
        : (args["handle"] !== undefined || args["path"] !== undefined ? [args] : []);
      for (const t of addressed) {
        const key = windowKey(
          typeof t["path"] === "string" ? t["path"] : undefined,
          typeof t["handle"] === "string" ? t["handle"] : undefined,
          typeof t["range"] === "string" ? t["range"] : undefined,
        );
        // This hop's OWN call must not repeat an EARLIER hop's window — a
        // qref-repack `next` re-offering a window a PRIOR hop already
        // executed is exactly the P1-9 dead loop.
        if (key !== undefined && hop.hopIndex > 0) {
          expect(executedWindows.has(key), `hop ${hop.hopIndex} re-executes window ${key}`).toBe(false);
        }
        if (key !== undefined) executedWindows.add(key);
      }
    }

    // The required fact (served via the byte-capped tail this zoom route
    // fetches) is present somewhere in the chain.
    const chainText = JSON.stringify(chain.hops.map((h) => h.response));
    expect(chainText).toContain("timeoutMs: 8400");
  });
});

// ===========================================================================
// P2-12 — `{qref, task:{force_serve:true}}` keeps the task's declared
// profile binding. Different query/content from qrefAfterCertified.
// ===========================================================================
function r5cSimpleAnswerWorkspace(): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-r5c-pb-"));
  tmpDirs.push(ws);
  writeFile(ws, "package.json", '{ "name": "r5c-pb", "private": true, "type": "module" }\n');
  writeFile(ws, "src/limits.ts", "export const MAX_UPLOAD_BYTES = 5_000_000;\n");
  writeFile(ws, "src/uploader.ts", "import { MAX_UPLOAD_BYTES } from \"./limits\";\n\nexport function assertUnderLimit(size: number): void {\n  if (size > MAX_UPLOAD_BYTES) throw new Error(\"too large\");\n}\n");
  return ws;
}

// Deliberately names the identifier (not a paraphrase): a paraphrase over
// these two related files resolves via an ambiguous-target candidate-list
// continuation first, whose OWN mid-chain profile_binding is a separate,
// pre-existing, broader question this fix does not touch (that continuation
// build has no STORED RECORD yet to restate — unlike force_serve, which
// REPLAYS an EXISTING certified record, exactly what P2-12 is about). Naming
// the identifier keeps this fixture a clean single-hop repro of that.
const DECLARED_QUERY = "What is MAX_UPLOAD_BYTES?";

describe("P2-12: force_serve keeps the declared profile binding", () => {
  it("a task explicitly declared task.profile:\"answer\" reports source:\"explicit\" even under force_serve", async () => {
    const ws = r5cSimpleAnswerWorkspace();
    const s = await server(ws);
    const first = (await s.callTool("read_file", { query: DECLARED_QUERY, task: { epoch: "new", profile: "answer" }, cwd: ws })).body;
    expect(first?.decision?.kind).toBe("act.answer");
    const qref: string = first?.qref;
    expect(typeof qref).toBe("string");

    // Two ordinary replays first (the always-worked door), then the forced one.
    for (let i = 0; i < 2; i += 1) {
      const replay = (await s.callTool("read_file", { qref, cwd: ws })).body;
      expect(replay?.profile_binding?.source, JSON.stringify(replay?.profile_binding)).toBe("explicit");
    }
    const forced = (await s.callTool("read_file", { qref, cwd: ws, task: { force_serve: true } })).body;
    expect(forced?.profile_binding?.requested, JSON.stringify(forced?.profile_binding)).toBe("answer");
    expect(forced?.profile_binding?.source, JSON.stringify(forced?.profile_binding)).toBe("explicit");
    // force_serve's own contract is unchanged: bytes ARE re-served (not a receipt).
    expect(forced?.kind).toBe("read.task_pack");
    expect(Array.isArray(forced?.evidence) && forced.evidence.some((e: any) => typeof e?.body === "string")).toBe(true);
  });

  it("control: an UNDECLARED task still reports source:\"inferred\" under force_serve (no false explicit)", async () => {
    const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-r5c-pb-ctrl-"));
    tmpDirs.push(ws);
    writeFile(ws, "package.json", '{ "name": "r5c-pb-ctrl", "private": true, "type": "module" }\n');
    writeFile(ws, "src/limits.ts", "export const MAX_RETRY_COUNT = 6;\n");
    writeFile(ws, "src/runner.ts", "import { MAX_RETRY_COUNT } from \"./limits\";\n\nexport function shouldStop(attempt: number): boolean {\n  return attempt >= MAX_RETRY_COUNT;\n}\n");
    const s = await server(ws);
    const first = (await s.callTool("read_file", {
      query: "What is the max retry count?",
      task: { epoch: "new" },
      cwd: ws,
    })).body;
    expect(first?.profile_binding?.requested ?? "auto").toBe("auto");
    const qref: string = first?.qref;
    expect(typeof qref).toBe("string");
    const forced = (await s.callTool("read_file", { qref, cwd: ws, task: { force_serve: true } })).body;
    expect(forced?.profile_binding?.source ?? "inferred", JSON.stringify(forced?.profile_binding)).not.toBe("explicit");
  });
});
