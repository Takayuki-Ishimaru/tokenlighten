/**
 * evaluation0929.certificateWireInvariant.spec.ts — WP-B (eval-0929 §5, §8):
 * A CERTIFICATE NEVER OUTLIVES ITS EVIDENCE.
 *
 * THE DEFECT (v0.14.4, eval-0929 §5). "In src/policy.ts, explain all
 * conditions of shouldRetry, including the actual values in TRANSIENT_CODES."
 * answered `act.answer` with no gap while the constant's file never reached
 * the client: the facet gate certified the value from the constant's window,
 * then `buildAnswerTaskPack`'s post-certification named-path cap
 * (TL142-05's 1.25x bound) removed that surface for not being the named file.
 * The same question without the path served the values.
 *
 * WHAT IS PINNED HERE, in four layers:
 *  1. the pure checker (`certificateWireInvariant.ts`): which citations a
 *     claim depends on (`every` / `any` / required surfaces), what counts as
 *     withdrawn, and the prevention predicate;
 *  2. the cap's new `keep` exemption on synthetic surfaces, with TL142-05's
 *     own intent as the recall control (an incidental extra is still capped);
 *  3. THE BACKSTOP: a spec seam (`setPostCertificationPassForTest`) plays a
 *     FUTURE post-certification remover that withdraws the cited constant
 *     window; the real in-process dispatcher must answer `discover` with a
 *     ranged `next` for exactly that window, never the old certificate — and
 *     the chain must then converge;
 *  4. the metamorphic acceptance (eval §8's table) on FRESH fixtures (names
 *     and values used nowhere else): with and without a file path (prefix and
 *     suffix), EN and JA, sentence and bullets, an unrelated same-name
 *     function, a `budget.bytes` of 6144 (the task-pack minimum), an `as`
 *     alias, and Python. In every variant the values reach the client or a
 *     disclosure names what did not; the path variants ship the same evidence
 *     paths as the pathless question (a named path is FOCUS, not a filter).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { TaskExecutionContract } from "@tokenlighten/types";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { expandedReadNextArguments } from "./helpers/readNext.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll } from "../util/session.js";
import { recordServedRange, servedClusterRanges, settleServedRanges, withdrawProvisionalServedRanges } from "../state/session.js";
import {
  capExtraEvidenceRelativeToNamedPaths,
  setPostCertificationPassForTest,
  type TaskPackSurface,
} from "../features/task-pack/readCodeTaskPack.js";
import {
  certificateCitations,
  certificateWireBreaches,
  parseCitedSpans,
  wouldIntroduceBreach,
  type CertifiedSurface,
  type ServedSpans,
} from "../features/task-pack/certificateWireInvariant.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  setPostCertificationPassForTest(undefined);
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

function makeWorkspace(tag: string, files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-wpb-${tag}-`));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return ws;
}

// ---------------------------------------------------------------------------
// Fresh fixtures (eval-0929 §5's two-file shape, new names and values).
// ---------------------------------------------------------------------------

const VALUES = ["421", "437", "509"] as const;
const TS_CODES = "src/limits/codes.ts";
const TS_DECIDE = "src/limits/decide.ts";

const TS_FILES: Readonly<Record<string, string>> = {
  [TS_CODES]: "export const RETRYABLE_STATUSES = new Set([421, 437, 509]);\n",
  [TS_DECIDE]: "import { RETRYABLE_STATUSES } from './codes.js';\nexport function mayRetry(status: number, tries: number): boolean {\n  return RETRYABLE_STATUSES.has(status) && tries < 5;\n}\n",
};
const TS_DECOY: Readonly<Record<string, string>> = {
  ...TS_FILES,
  "src/zz_legacy.ts": "export function mayRetry(status: number): boolean { return status === 0; }\n",
};
const TS_ALIAS: Readonly<Record<string, string>> = {
  ...TS_FILES,
  [TS_DECIDE]: "import { RETRYABLE_STATUSES as RETRYABLE } from './codes.js';\nexport function mayRetry(status: number, tries: number): boolean {\n  return RETRYABLE.has(status) && tries < 5;\n}\n",
};
const PY_FILES: Readonly<Record<string, string>> = {
  "jobs/statuses.py": "RETRYABLE_STATUSES = frozenset({421, 437, 509})\n",
  "jobs/decide.py": "from jobs.statuses import RETRYABLE_STATUSES\n\n\ndef may_retry(status, tries):\n    return status in RETRYABLE_STATUSES and tries < 5\n",
};

const Q_NO_PATH = "Explain all conditions of mayRetry, including the actual values in RETRYABLE_STATUSES.";
const Q_PATH = `In ${TS_DECIDE}, explain all conditions of mayRetry, including the actual values in RETRYABLE_STATUSES.`;

// ---------------------------------------------------------------------------
// 1. The pure checker.
// ---------------------------------------------------------------------------

function spans(entries: Record<string, Array<[number, number]>>): ServedSpans {
  return new Map(Object.entries(entries));
}

function contractWith(
  obligations: Array<{ id: string; status?: "proved" | "uncovered"; evidence?: Array<{ handle: string; path: string; range: string }> }>,
  evidenceHandles: string[] = [],
): TaskExecutionContract {
  return {
    readiness_certificate: {
      version: 1,
      id: "ready-test",
      task_fingerprint: "task-test",
      profile: "answer",
      obligations: obligations.map((obligation) => ({
        id: obligation.id,
        kind: "concern",
        status: obligation.status ?? "proved",
        required: true,
        ...(obligation.evidence !== undefined ? { evidence: obligation.evidence } : {}),
      })),
      evidence_handles: evidenceHandles,
      action_frontier: [],
    },
  } as unknown as TaskExecutionContract;
}

describe("certificateWireInvariant: which citations a certified claim depends on", () => {
  const focal = { handle: "h-focal", path: "src/decide.ts", range: "2-4" };
  const constant = { handle: "h-const", path: "src/codes.ts", range: "1-1" };
  const certified = spans({ "src/decide.ts": [[2, 4]], "src/codes.ts": [[1, 1]] });

  it("a request-item (facet) citation is `every`: withdrawing ONE of its windows is a breach naming exactly those lines", () => {
    const citations = certificateCitations(contractWith([{ id: "request-item:facet-1:value", evidence: [focal, constant] }]), []);
    expect(citations).toEqual([expect.objectContaining({ obligationId: "request-item:facet-1:value", mode: "every" })]);
    const breaches = certificateWireBreaches(citations, certified, spans({ "src/decide.ts": [[2, 4]] }));
    expect(breaches).toEqual([{ obligationId: "request-item:facet-1:value", handle: "h-const", path: "src/codes.ts", lost: [[1, 1]] }]);
  });

  it("any other citation is `any`: it stands while one cited window is still delivered, and breaks when none is", () => {
    const citations = certificateCitations(contractWith([{ id: "identifier:mayRetry", evidence: [focal, constant] }]), []);
    expect(citations[0]?.mode).toBe("any");
    expect(certificateWireBreaches(citations, certified, spans({ "src/decide.ts": [[2, 4]] }))).toEqual([]);
    expect(certificateWireBreaches(citations, certified, spans({})).map((breach) => breach.handle)).toEqual(["h-focal", "h-const"]);
  });

  it("only lines THIS response carried at certification can be withdrawn: a carried (resident) window is never lost", () => {
    const carried = { handle: "h-carried", path: "src/earlier.ts", range: "1-4,9-12" };
    expect(parseCitedSpans(carried.range)).toEqual([[1, 4], [9, 12]]);
    const citations = certificateCitations(contractWith([{ id: "request-item:facet-2:condition", evidence: [focal, carried] }]), []);
    expect(certificateWireBreaches(citations, certified, certified)).toEqual([]);
  });

  it("a NARROWED window loses exactly the withdrawn lines, and an unproved obligation cites nothing", () => {
    const citations = certificateCitations(contractWith([
      { id: "request-item:facet-1:condition", evidence: [focal] },
      { id: "request-item:facet-2:value", status: "uncovered", evidence: [constant] },
    ]), []);
    expect(citations.map((citation) => citation.obligationId)).toEqual(["request-item:facet-1:condition"]);
    const breaches = certificateWireBreaches(citations, certified, spans({ "src/decide.ts": [[2, 2]] }));
    expect(breaches.map((breach) => breach.lost)).toEqual([[[3, 4]]]);
  });

  it("a compacted certificate (no per-obligation evidence) falls back to evidence_handles, every one load-bearing", () => {
    const surfaces: CertifiedSurface[] = [
      { ...focal, shipped: true },
      { ...constant, shipped: true },
      { handle: "h-other", path: "src/other.ts", range: "1-9", shipped: true },
    ];
    const citations = certificateCitations(contractWith([{ id: "surface-content" }, { id: "request-item:facet-1:value" }], ["h-focal", "h-const"]), surfaces);
    expect(citations).toEqual([expect.objectContaining({ obligationId: "certificate", mode: "every" })]);
    expect(certificateWireBreaches(citations, certified, spans({ "src/decide.ts": [[2, 4]] })).map((breach) => breach.handle)).toEqual(["h-const"]);
  });

  it("a `required` surface is load-bearing for surface-content even when an `any` citation still stands", () => {
    const surfaces: CertifiedSurface[] = [{ ...focal, shipped: true, required: true }, { ...constant, shipped: true }];
    const citations = certificateCitations(contractWith([{ id: "surface-content", evidence: [focal, constant] }]), surfaces);
    const breaches = certificateWireBreaches(citations, certified, spans({ "src/codes.ts": [[1, 1]] }));
    expect(breaches.map((breach) => `${breach.obligationId}:${breach.handle}`)).toEqual(["surface-content:h-focal"]);
  });

  it("the prevention predicate flags only a withdrawal that breaks a citation the current set still satisfies", () => {
    const citations = certificateCitations(contractWith([
      { id: "request-item:facet-1:value", evidence: [constant] },
      { id: "identifier:mayRetry", evidence: [focal, { handle: "h-decoy", path: "src/zz.ts", range: "1-1" }] },
    ]), []);
    const all = spans({ "src/decide.ts": [[2, 4]], "src/codes.ts": [[1, 1]], "src/zz.ts": [[1, 1]] });
    const certifiedAll = all;
    expect(wouldIntroduceBreach(citations, certifiedAll, all, spans({ "src/decide.ts": [[2, 4]], "src/zz.ts": [[1, 1]] }))).toBe(true);
    expect(wouldIntroduceBreach(citations, certifiedAll, all, spans({ "src/decide.ts": [[2, 4]], "src/codes.ts": [[1, 1]] }))).toBe(false);
    expect(wouldIntroduceBreach([], certifiedAll, all, spans({}))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The cap's `keep` exemption — TL142-05's intent is the recall control.
// ---------------------------------------------------------------------------

describe("capExtraEvidenceRelativeToNamedPaths: cited evidence is focus, incidental extras are still capped", () => {
  function surface(over: Partial<TaskPackSurface> & { path: string; code: string }): TaskPackSurface {
    return { role: "context", handle: `h-${over.path}`, range: "1-1", ...over };
  }

  it("keeps the surface a certified value cites and still drops the incidental extra", () => {
    const ws = makeWorkspace("cap", { "src/named.ts": "x".repeat(20) });
    const cited = surface({ path: "src/codes.ts", why: "symbol hit for unknown", code: "c".repeat(15) });
    const incidental = surface({ path: "src/noise.ts", why: "root-markdown-title-match", code: "n".repeat(15) });
    // The cited surface is LAST, so C26's positional order would drop it first.
    const surfaces: TaskPackSurface[] = [incidental, cited];
    const citations = certificateCitations(
      contractWith([{ id: "request-item:facet-1:value", evidence: [{ handle: cited.handle, path: cited.path, range: "1-1" }] }]),
      [],
    );
    const certified = spans({ "src/codes.ts": [[1, 1]], "src/noise.ts": [[1, 1]] });
    const spansOf = (current: readonly TaskPackSurface[]): ServedSpans =>
      new Map(current.map((entry) => [entry.path, [[1, 1] as [number, number]]] as const));
    capExtraEvidenceRelativeToNamedPaths(surfaces, "Explain named.ts", ws, (candidate, current) =>
      wouldIntroduceBreach(citations, certified, spansOf(current), spansOf(current.filter((entry) => entry !== candidate))));
    expect(surfaces.map((entry) => entry.path)).toEqual(["src/codes.ts"]);
  });

  it("without `keep` the drop order is exactly C26's (same inputs, the cited surface goes)", () => {
    const ws = makeWorkspace("cap-nokeep", { "src/named.ts": "x".repeat(20) });
    const surfaces: TaskPackSurface[] = [
      surface({ path: "src/noise.ts", why: "root-markdown-title-match", code: "n".repeat(15) }),
      surface({ path: "src/codes.ts", why: "symbol hit for unknown", code: "c".repeat(15) }),
    ];
    capExtraEvidenceRelativeToNamedPaths(surfaces, "Explain named.ts", ws);
    expect(surfaces.map((entry) => entry.path)).toEqual(["src/noise.ts"]);
  });
});

describe("withdrawProvisionalServedRanges: retracts only this call's unsettled bookings", () => {
  it("withdraws the provisional span and keeps an earlier call's settled residency", () => {
    const ws = makeWorkspace("ledger", { "src/codes.ts": "a\nb\nc\nd\n" });
    resetAll();
    recordServedRange(ws, "src/codes.ts", "sha256:aa", 3, 4, 4);
    settleServedRanges(ws, { unattributed: false, windows: [{ path: "src/codes.ts", start: 3, end: 4 }] });
    recordServedRange(ws, "src/codes.ts", "sha256:aa", 1, 1, 4);
    expect(servedClusterRanges(ws, "src/codes.ts")).toEqual(["1-1", "3-4"]);
    expect(withdrawProvisionalServedRanges(ws, [{ path: "src/codes.ts", start: 1, end: 1 }])).toBe(1);
    expect(servedClusterRanges(ws, "src/codes.ts")).toEqual(["3-4"]);
    // Nothing pending is left, so a second withdrawal can take nothing.
    expect(withdrawProvisionalServedRanges(ws, [{ path: "src/codes.ts", start: 3, end: 4 }])).toBe(0);
    expect(servedClusterRanges(ws, "src/codes.ts")).toEqual(["3-4"]);
  });
});

// ---------------------------------------------------------------------------
// 3. THE BACKSTOP — a future post-certification remover (spec seam).
// ---------------------------------------------------------------------------

async function inProcess(ws: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await callTool("tl_read_file", { cwd: ws, ...args });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  return JSON.parse(text) as Record<string, any>;
}

function bodiesOf(responses: ReadonlyArray<Record<string, any>>): string {
  return responses
    .flatMap((response) => (Array.isArray(response["evidence"]) ? response["evidence"] : []))
    .map((entry: any) => (typeof entry?.body === "string" ? entry.body : ""))
    .join("\n");
}

function nextOf(response: Record<string, any>): { tool: string; arguments: Record<string, unknown> } | undefined {
  for (const candidate of [response["decision"]?.next, response["next"], response["limit"]?.next]) {
    if (candidate !== undefined && typeof candidate?.tool === "string") return candidate;
  }
  return undefined;
}

describe("THE BACKSTOP: a certificate whose cited evidence a late pass withdrew is never shipped", () => {
  beforeEach(() => {
    resetAll();
    handleTable.reset();
  });

  it("control: without a late remover the pathless question is one-hop act.answer with the values", async () => {
    const ws = makeWorkspace("seam-control", TS_FILES);
    const hop0 = await inProcess(ws, { query: Q_NO_PATH, task: { epoch: "new", profile: "answer" } });
    expect(hop0["decision"]?.kind).toBe("act.answer");
    for (const value of VALUES) expect(bodiesOf([hop0])).toContain(value);
  });

  it("withdrawing the certified constant window after certification downgrades to discover with a ranged next for exactly that window, then converges", async () => {
    // TL_EFF_AUTOFOLLOW=0 (default ON since 2026-10-19): the downgrade's
    // ranged `next` re-issues the request, which the server now follows in
    // the same call (next test). This one keeps the downgraded pack itself
    // on the wire.
    await withAutofollowOff(async () => {
      const ws = makeWorkspace("seam", TS_FILES);
      let withdrawn = 0;
      setPostCertificationPassForTest((surfaces) => {
        for (let index = surfaces.length - 1; index >= 0; index--) {
          if (surfaces[index]!.path === TS_CODES) {
            surfaces.splice(index, 1);
            withdrawn += 1;
          }
        }
        setPostCertificationPassForTest(undefined);
      });
      const hop0 = await inProcess(ws, { query: Q_NO_PATH, task: { epoch: "new", profile: "answer" } });
      expect(withdrawn, "the seam must have removed the constant's surface").toBeGreaterThan(0);
      const decision = hop0["decision"] ?? {};
      expect(decision.kind, `a certificate may not outlive its evidence; got ${JSON.stringify(decision)}`).not.toBe("act.answer");
      expect(decision.certificate).toBeUndefined();
      expect(bodiesOf([hop0])).not.toContain("421");
      const next = nextOf(hop0);
      expect(next?.tool).toBe("tl_read_file");
      // v0.16.0 (release note: "Clients follow a short reference instead of
      // repeating the full arguments"): a long read `next` is a `{cwd, cursor}`
      // reference. Expand it -- without consuming its once-only plan -- to see
      // which window it asks for.
      const targets = (expandedReadNextArguments(next?.arguments, ws)?.["targets"] ?? []) as Array<{ path?: string; range?: string }>;
      expect(
        targets.some((target) => target.path === TS_CODES && target.range === "1-1"),
        `next must re-read exactly the withdrawn window; got ${JSON.stringify(next)}`,
      ).toBe(true);
      // Every non-act outcome keeps an executable way forward, and following it converges.
      const responses = [hop0];
      let call = next;
      for (let hop = 1; hop < 6 && call !== undefined; hop++) {
        const response = await inProcess(ws, call.arguments);
        responses.push(response);
        call = nextOf(response);
      }
      const last = responses[responses.length - 1]!;
      expect(last["decision"]?.kind).toBe("act.answer");
      for (const value of VALUES) expect(bodiesOf(responses)).toContain(value);
    });
  });

  it("default (TL_EFF_AUTOFOLLOW): the downgrade's ranged next runs in the same call, and the one act.answer delivers the window its certificate cites", async () => {
    const ws = makeWorkspace("seam-followed", TS_FILES);
    let withdrawn = 0;
    setPostCertificationPassForTest((surfaces) => {
      for (let index = surfaces.length - 1; index >= 0; index--) {
        if (surfaces[index]!.path === TS_CODES) {
          surfaces.splice(index, 1);
          withdrawn += 1;
        }
      }
      setPostCertificationPassForTest(undefined);
    });
    const hop0 = await inProcess(ws, { query: Q_NO_PATH, task: { epoch: "new", profile: "answer" } });
    expect(withdrawn, "the seam must have removed the constant's surface").toBeGreaterThan(0);
    // Had the backstop shipped the withdrawn certificate, this reply would be
    // an act.answer that was never followed and lacks the constant: the
    // certificate here is the follow-up's, over the window it re-read.
    expect(hop0["auto_followed"], JSON.stringify(hop0["decision"])).toBeDefined();
    expect(hop0["decision"]?.kind).toBe("act.answer");
    expect(hop0["decision"]?.certificate).toBeDefined();
    for (const value of VALUES) expect(bodiesOf([hop0])).toContain(value);
  });
});

/** Runs `fn` under TL_EFF_AUTOFOLLOW=0 (the rollback), then restores the caller's value. */
async function withAutofollowOff<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env["TL_EFF_AUTOFOLLOW"];
  process.env["TL_EFF_AUTOFOLLOW"] = "0";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["TL_EFF_AUTOFOLLOW"];
    else process.env["TL_EFF_AUTOFOLLOW"] = saved;
  }
}

// ---------------------------------------------------------------------------
// 4. Metamorphic acceptance (eval §8), spawned dev servers, fresh fixtures.
// ---------------------------------------------------------------------------

async function ask(ws: string, query: string, extra: Record<string, unknown> = {}): Promise<ChainResult> {
  const server = startDevServer(ws, "default");
  servers.push(server);
  await server.initialize();
  return followNextToEnd(
    server,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws, ...extra } },
    // The evaluator's own loop: follow `next` until there is none (no qref re-pack).
    { cwd: ws, hopCap: 8, maxQrefRepacks: 0 },
  );
}

function chainBodies(chain: ChainResult): string {
  return bodiesOf(chain.hops.map((hop) => hop.response as Record<string, any>));
}

function evidencePaths(chain: ChainResult): string[] {
  return [...new Set(chain.hops.flatMap((hop) =>
    (Array.isArray(hop.response?.evidence) ? hop.response.evidence : []).map((entry: any) => String(entry?.path ?? ""))))].sort();
}

/** eval §8's invariant: an `act.answer` either carries every value or discloses what it could not determine. */
function expectServedOrDisclosed(label: string, chain: ChainResult, values: readonly string[]): void {
  const final = chain.final ?? {};
  const decision = final.decision ?? {};
  const text = chainBodies(chain);
  const missing = values.filter((value) => !text.includes(value));
  const gaps: string[] = Array.isArray(decision.certificate?.gaps) ? decision.certificate.gaps : [];
  const disclosed = gaps.some((gap) => /request-item-(?:undetermined|empty):/.test(gap));
  expect(
    decision.kind !== "act.answer" || missing.length === 0 || disclosed,
    `[${label}] silent act.answer: missing ${JSON.stringify(missing)}, gaps ${JSON.stringify(gaps)}`,
  ).toBe(true);
  expect(chain.capped, `[${label}] the chain must end on its own`).toBe(false);
}

describe("metamorphic acceptance: the values reach the client in every meaning-preserving variant", () => {
  it("TS: path prefix / suffix, JA, bullets, same-name decoy and a 6144-byte budget serve the values; the path variant ships the pathless evidence set", async () => {
    const noPath = await ask(makeWorkspace("m-nopath", TS_FILES), Q_NO_PATH);
    const variants: Array<[string, Readonly<Record<string, string>>, string, Record<string, unknown>]> = [
      ["path-prefix", TS_FILES, Q_PATH, {}],
      ["path-suffix", TS_FILES, `Explain the conditions of mayRetry in ${TS_DECIDE}.`, {}],
      ["ja-path", TS_FILES, `${TS_DECIDE} の mayRetry の条件と RETRYABLE_STATUSES の実際の値を説明して`, {}],
      ["bullets-path", TS_FILES, `In ${TS_DECIDE}:\n- explain all conditions of mayRetry\n- include the actual values in RETRYABLE_STATUSES`, {}],
      ["decoy-path", TS_DECOY, Q_PATH, {}],
      ["decoy-path-suffix", TS_DECOY, `Explain the conditions of mayRetry in ${TS_DECIDE}.`, {}],
      ["budget-path", TS_FILES, Q_PATH, { budget: { bytes: 6144 } }],
    ];
    const results: Array<[string, ChainResult]> = [["no-path", noPath]];
    for (const [label, files, query, extra] of variants) {
      results.push([label, await ask(makeWorkspace(`m-${label}`, files), query, extra)]);
    }
    for (const [label, chain] of results) {
      expectServedOrDisclosed(label, chain, VALUES);
      for (const value of VALUES) expect(chainBodies(chain), `[${label}] value ${value} must reach the client`).toContain(value);
      expect(chain.final?.decision?.kind, `[${label}]`).toBe("act.answer");
      expect(chain.hops.length, `[${label}] one hop, as the pathless question`).toBe(1);
    }
    // Recall control: the pathless question is unchanged (one hop, the same
    // evidence paths), and naming the path does not narrow what ships — the
    // same files, within a few percent of the same bytes.
    expect(evidencePaths(noPath)).toEqual([TS_CODES, TS_DECIDE]);
    const pathPrefix = results.find(([label]) => label === "path-prefix")![1];
    expect(evidencePaths(pathPrefix)).toEqual(evidencePaths(noPath));
    const bytesOf = (chain: ChainResult): number => chain.hops.reduce((sum, hop) => sum + hop.textBytes, 0);
    expect(Math.abs(bytesOf(pathPrefix) - bytesOf(noPath)) / bytesOf(noPath)).toBeLessThan(0.05);
  }, 180_000);

  it("a 6144-byte budget that forces continuation over a large named function still delivers the values", async () => {
    const branches = Array.from({ length: 160 }, (_, i) =>
      `  if (status === ${2000 + i} && tries > ${i % 7}) { note("branch-${i}", status, tries); }`).join("\n");
    const files = {
      [TS_CODES]: TS_FILES[TS_CODES]!,
      [TS_DECIDE]: `import { RETRYABLE_STATUSES } from './codes.js';\nfunction note(label: string, status: number, tries: number): void { void label; void status; void tries; }\nexport function mayRetry(status: number, tries: number): boolean {\n${branches}\n  return RETRYABLE_STATUSES.has(status) && tries < 5;\n}\n`,
    };
    const chain = await ask(makeWorkspace("m-budget-large", files), Q_PATH, { budget: { bytes: 6144 } });
    expectServedOrDisclosed("budget-continuation", chain, VALUES);
    for (const value of VALUES) expect(chainBodies(chain), `[budget-continuation] value ${value}`).toContain(value);
    for (const hop of chain.hops) expect(hop.textBytes, `[budget-continuation] hop ${hop.hopIndex} within budget`).toBeLessThanOrEqual(6144 + 600);
  }, 120_000);

  it("an `as` alias and Python keep the invariant (values served, or the unresolved value disclosed)", async () => {
    const alias = await ask(makeWorkspace("m-alias", TS_ALIAS), Q_PATH);
    expectServedOrDisclosed("alias-path", alias, VALUES);
    const py = await ask(
      makeWorkspace("m-py", PY_FILES),
      "In jobs/decide.py, explain all conditions of may_retry, including the actual values in RETRYABLE_STATUSES.",
    );
    expectServedOrDisclosed("py-path", py, VALUES);
    for (const value of VALUES) expect(chainBodies(py), `[py-path] value ${value}`).toContain(value);
  }, 120_000);
});
