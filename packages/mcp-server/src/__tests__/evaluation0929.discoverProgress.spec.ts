/**
 * evaluation0929.discoverProgress.spec.ts — WP-M (eval-0929, adopted INT chip,
 * freeze-rule category "non-terminating chains").
 *
 * DEFECT (pre-existing in v0.14.4, byte-identical on both builds — confirmed
 * via `~/.cache/tokenlighten-wave-0929/osc/repro-osc-report.mjs`): a task
 * whose query names a real code symbol AND an identifier that no file
 * DECLARES, but that a HANDFUL of prose documents MENTION, oscillates
 * forever between the mention sites. Hop 1 proposes doc A; hop 2 (after A is
 * served) proposes doc B; hop 3 proposes doc A AGAIN even though it was
 * served two hops ago; the 2-cycle repeats under one unchanging task handle,
 * never reaching a terminal decision.
 *
 * ROOT CAUSE 1 (readCodeTaskPack.ts's `computeUndeclaredIdentifierReadCall`,
 * the "FIX-G G3" recovery for an `identifier:<X>` obligation nothing
 * declares): its "already served" check read only
 * `codeTaskPackSurfaces(result.surfaces)` — THIS CALL's own freshly-served
 * surfaces, never a PRIOR hop's serve of the same task. Each hop therefore
 * "forgot" whichever mention site an EARLIER hop had already served, so the
 * candidate exclusion reset every hop and the two mention sites alternated
 * indefinitely. Fixed by judging "served" against the task's own
 * served-range ledger (`state/session.ts`'s `servedRangeLedger`, read via
 * `servedRangeCoverage`) at the candidate's CURRENT sha — the same
 * cumulative, sha-gated authority `epochServedEvidence`'s
 * `reconstructServedEntryEvidence` already uses for the request-item engine
 * a few thousand lines below. A sha mismatch still reports "no claim" (rule:
 * a range served at an older revision counts as unserved), so a resume after
 * a real external edit keeps working.
 *
 * ROOT CAUSE 2 (same file, `nextCallForUnresolved`'s "wiring-source" branch):
 * the identical this-call-only pattern — `new
 * Set(result.surfaces.map(surface => surface.path))` — gated a qualified
 * symbol anchor's candidate DEFINITION sites. Structurally the same bug for a
 * different obligation kind (>=2 definition candidates for one qualified
 * anchor); fixed the same way.
 *
 * Neither is Markdown-specific, docs/-specific, fixture-specific or
 * Japanese-specific: the mechanism is a plain candidate-exclusion filter over
 * `result.surfaces`, reused verbatim for any language the repo's file walk
 * covers (TS/JS, Python, Go, Java, Kotlin, C#, Rust, C/C++ included).
 *
 * This file proves progress + termination end to end (`startDevServer`,
 * following `next` up to 8 hops) across the metamorphic table the brief
 * requires, plus two unit-level probes of the served-range-ledger check
 * itself (a stale-sha resume must still re-serve once; a fresh workspace must
 * behave exactly as before this fix).
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  type ChainResult,
  type Hop,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import { buildTaskExecutionContract } from "../features/task-pack/readCodeTaskPack.js";
import type { TaskPackResult } from "../features/task-pack/model.js";
import { recordServedRange, settleServedRanges } from "../state/session.js";
import { shaOfText } from "../util/handles.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// Fixture builders — fresh names/paths, never the diagnostic repro's own
// (`validateToken`/`RETRY_BUDGET_MS`/`docs/ops-notes.md`); a real code symbol
// plus 0-3 prose-only mention sites for an identifier nothing declares.
// ---------------------------------------------------------------------------

function write(root: string, rel: string, text: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** A real function, padded past the first slice so its own declaration needs
 *  its own zoom — the shape that keeps the identifier as the sole remaining
 *  open point once the code question is answered. */
function focalFileText(fnName: string, paddingCount = 20): string {
  const helpers: string[] = [];
  for (let i = 1; i <= paddingCount; i++) {
    helpers.push(
      `/** Unrelated helper #${i} — pads the file so ${fnName} sits past the first slice. */`,
      `export function unrelatedHelper${i}(input: string): string {`,
      `  const trimmed = input.trim();`,
      `  if (trimmed.length === 0) { return "empty-${i}"; }`,
      `  return trimmed + "-${i}";`,
      "}",
      "",
    );
  }
  return [
    "export interface TokenPayload { sub: string; exp: number }",
    "export interface TokenValidation { ok: boolean; reason?: string }",
    "",
    ...helpers,
    `/** Validates a decoded token payload against the current time. */`,
    `export function ${fnName}(payload: TokenPayload, now: number): TokenValidation {`,
    `  if (typeof payload.exp !== "number") { return { ok: false, reason: "missing-exp" }; }`,
    `  if (payload.exp <= now) { return { ok: false, reason: "expired" }; }`,
    `  return { ok: true };`,
    "}",
    "",
  ].join("\n");
}

function writeHandlers(ws: string, count: number, fnName: string): void {
  for (let i = 1; i <= count; i++) {
    const lines = [`import { ${fnName} } from "../auth.js";`, ""];
    for (let k = 0; k < 12; k++) lines.push(`export function handler${i}_${k}(input: string): string { return input + "${i}-${k}"; }`);
    lines.push("", `export function guard${i}(payload: TokenPayload, now: number): boolean { return ${fnName}(payload, now).ok; }`, "");
    write(ws, `src/handlers/h${i}.ts`, lines.join("\n"));
  }
}

const DOC_BUILDERS: ReadonlyArray<(term: string) => string> = [
  (term) => ["# Incident retro", "", `During the outage, ${term} was raised temporarily; the on-call`, "notes disagree about whether it reverted afterward.", ""].join("\n"),
  (term) => ["# Operational notes", "", `The retry budget (${term}) governs how long a client waits before`, "giving up; it is configured per-deployment and is not tracked as a", "source constant in this repository.", ""].join("\n"),
  (term) => ["# Runbook", "", `${term} is referenced in the on-call runbook too; see the incident retro.`, ""].join("\n"),
];
const DOC_PATHS: readonly string[] = ["docs/incident-report.md", "docs/ops-notes.md", "docs/runbook.md"];

function queryFor(fnName: string, term: string, lang: "en" | "ja"): string {
  return lang === "ja"
    ? `${fnName} の有効期限判定を説明してください。${term} の値も教えてください。`
    : `Explain ${fnName}'s expiry check. Also tell me the value of ${term}.`;
}

interface WorkspaceOptions {
  fnName: string;
  term: string;
  /** 0-3 doc mention sites (docs/*.md), or "comments" for two source-file
   *  comment-only mentions, or "none" for no mention at all (bare-alone case
   *  still needs the term somewhere to stay non-trivial; callers pass docs=1
   *  there instead). */
  docs: 0 | 1 | 2 | 3;
  mentionKind?: "docs" | "comments";
  handlerCount?: number;
}

function buildWorkspace(tag: string, opts: WorkspaceOptions): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-discprog-${tag}-`));
  tmpDirs.push(ws);
  write(ws, "package.json", `{\n  "name": "${tag}",\n  "private": true,\n  "type": "module"\n}\n`);
  write(ws, "src/auth.ts", focalFileText(opts.fnName));
  writeHandlers(ws, opts.handlerCount ?? 40, opts.fnName);
  if ((opts.mentionKind ?? "docs") === "docs") {
    for (let i = 0; i < opts.docs; i++) write(ws, DOC_PATHS[i]!, DOC_BUILDERS[i]!(opts.term));
  } else {
    write(ws, "src/noteA.ts", `// ${opts.term} governs the retry loop below; kept only as a comment.\nexport function noteA(): number { return 1; }\n`);
    write(ws, "src/noteB.ts", `// See ${opts.term} in src/noteA.ts for context; not defined here either.\nexport function noteB(): number { return 2; }\n`);
  }
  return ws;
}

async function spawnedServer(ws: string): Promise<ServerHandle> {
  const server = startDevServer(ws, "default", { toolSurface: "full" });
  servers.push(server);
  await server.initialize();
  return server;
}

// ---------------------------------------------------------------------------
// Chain-shape assertions shared by every metamorphic variant.
// ---------------------------------------------------------------------------

/** `{tool, arguments}` with every per-hop routing field (`cwd`, `task`)
 *  stripped, so two hops naming the SAME semantic call compare equal
 *  regardless of which task handle or cwd rode along with them. */
function canonicalSignature(call: { tool: string; arguments: Record<string, unknown> }): string {
  const { cwd, task, ...rest } = call.arguments;
  return JSON.stringify({ tool: call.tool, arguments: rest });
}

function assertNoRepeatedNext(hops: readonly Hop[]): void {
  const seen = new Set<string>();
  for (const hop of hops) {
    const sig = canonicalSignature(hop.call);
    expect(seen.has(sig), `a later hop repeated an earlier call verbatim: ${sig}`).toBe(false);
    seen.add(sig);
  }
}

/** No two hops serve a body for the identical (path, range) pair — a coarse,
 *  easy-to-verify proxy for "every discover hop serves at least one new
 *  line". */
function assertEachServedBodyIsNew(hops: readonly Hop[]): void {
  const seen = new Set<string>();
  for (const hop of hops) {
    for (const ev of hop.response?.evidence ?? []) {
      if (ev?.body === undefined) continue;
      const key = `${ev.path}::${ev.range ?? JSON.stringify(ev.ranges)}`;
      expect(seen.has(key), `hop re-served an identical (path, range) with a body: ${key}`).toBe(false);
      seen.add(key);
    }
  }
}

function fullChainText(hops: readonly Hop[]): string {
  return hops.map((hop) => JSON.stringify(hop.response)).join("\n");
}

/** The identifier is disclosed somewhere (a gap/certificate/unresolved entry
 *  names it), is never certified `request-item-absent`/`request-item-empty`
 *  for it (it DOES occur — a zero-occurrence claim would be false), and no
 *  hop assigns it a fabricated value. */
function assertIdentifierHonestlyOpen(hops: readonly Hop[], term: string): void {
  const text = fullChainText(hops);
  expect(text, `identifier ${term} never named anywhere in the chain`).toContain(term);
  expect(text).not.toContain(`request-item-absent:${term}`);
  expect(text).not.toContain(`request-item-empty:${term}`);
  // Never "TERM = 123" / "TERM: 123" / quoted — this repo never declares it,
  // so no served or certified text may pair it with an assigned value.
  expect(text).not.toMatch(new RegExp(`${term}\\s*[=:]\\s*["']?[0-9]`));
}

function assertFocalBodyServed(hops: readonly Hop[], fnName: string): void {
  expect(fullChainText(hops)).toContain(`function ${fnName}(`);
}

/**
 * `maxQrefRepacks: 0` deliberately — this suite checks the DISCOVER chain's
 * own `next` never oscillates/repeats, which is fully decided by the calls
 * the server itself names. `followNextToEnd`'s bare-`{qref}` fallback (its
 * default: retry twice after a dead end) is a DIFFERENT, harness-level
 * check-in that legitimately repeats the identical `{qref}` call when the
 * task has nothing further to report — a fact about the test helper, not an
 * `act.*`/`discover` producer re-offering a call it already made, which is
 * what rule 3's backstop is about.
 */
async function runChain(server: ServerHandle, ws: string, query: string): Promise<ChainResult> {
  return followNextToEnd(
    server,
    { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } },
    { cwd: ws, hopCap: 8, maxQrefRepacks: 0 },
  );
}

// ---------------------------------------------------------------------------
// The primary repro and its metamorphic variants (rule 12 / this WP's brief):
// EN/JA, 1/2/3 docs, comments instead of docs, identifier asked alone.
// ---------------------------------------------------------------------------

describe("WP-M: a real code question plus an undeclared, prose-mentioned identifier terminates instead of oscillating", () => {
  it("JA, 2 mention sites (the primary repro shape): terminates, never repeats a next, discloses the identifier", async () => {
    const ws = buildWorkspace("ja2", { fnName: "checkQuota", term: "MAX_QUOTA_UNITS", docs: 2 });
    const server = await spawnedServer(ws);
    const result = await runChain(server, ws, queryFor("checkQuota", "MAX_QUOTA_UNITS", "ja"));

    expect(result.capped, `chain never reached a terminal decision within 8 hops: ${JSON.stringify(result.hops.map((h) => h.call))}`).toBe(false);
    assertNoRepeatedNext(result.hops);
    assertEachServedBodyIsNew(result.hops);
    assertFocalBodyServed(result.hops, "checkQuota");
    assertIdentifierHonestlyOpen(result.hops, "MAX_QUOTA_UNITS");
  }, 60_000);

  it("EN, 2 mention sites: the same shape, language-independent", async () => {
    const ws = buildWorkspace("en2", { fnName: "checkQuota", term: "MAX_QUOTA_UNITS", docs: 2 });
    const server = await spawnedServer(ws);
    const result = await runChain(server, ws, queryFor("checkQuota", "MAX_QUOTA_UNITS", "en"));

    expect(result.capped).toBe(false);
    assertNoRepeatedNext(result.hops);
    assertEachServedBodyIsNew(result.hops);
    assertFocalBodyServed(result.hops, "checkQuota");
    assertIdentifierHonestlyOpen(result.hops, "MAX_QUOTA_UNITS");
  }, 60_000);

  it("1 mention site: terminates the same honest way (metamorphic — no special-casing of the 2-candidate shape)", async () => {
    const ws = buildWorkspace("doc1", { fnName: "checkQuota", term: "MAX_QUOTA_UNITS", docs: 1 });
    const server = await spawnedServer(ws);
    const result = await runChain(server, ws, queryFor("checkQuota", "MAX_QUOTA_UNITS", "ja"));

    expect(result.capped).toBe(false);
    assertNoRepeatedNext(result.hops);
    assertEachServedBodyIsNew(result.hops);
    assertFocalBodyServed(result.hops, "checkQuota");
    assertIdentifierHonestlyOpen(result.hops, "MAX_QUOTA_UNITS");
  }, 60_000);

  it("3 mention sites: scales past the 2-candidate special case", async () => {
    const ws = buildWorkspace("doc3", { fnName: "checkQuota", term: "MAX_QUOTA_UNITS", docs: 3 });
    const server = await spawnedServer(ws);
    const result = await runChain(server, ws, queryFor("checkQuota", "MAX_QUOTA_UNITS", "ja"));

    expect(result.capped, `did not settle within 8 hops with 3 candidates: ${JSON.stringify(result.hops.map((h) => h.call))}`).toBe(false);
    assertNoRepeatedNext(result.hops);
    assertEachServedBodyIsNew(result.hops);
    assertFocalBodyServed(result.hops, "checkQuota");
    assertIdentifierHonestlyOpen(result.hops, "MAX_QUOTA_UNITS");
  }, 60_000);

  it("mentioned only in comments of 2 source files (never docs/): comment-only mentions are excluded as candidates, so the chain settles in a couple of hops with no risk of alternation", async () => {
    const ws = buildWorkspace("comments", { fnName: "checkQuota", term: "MAX_QUOTA_UNITS", docs: 0, mentionKind: "comments" });
    const server = await spawnedServer(ws);
    const result = await runChain(server, ws, queryFor("checkQuota", "MAX_QUOTA_UNITS", "ja"));

    expect(result.capped).toBe(false);
    assertNoRepeatedNext(result.hops);
    assertFocalBodyServed(result.hops, "checkQuota");
    // A comment mention is not a code declaration and not evidence for a
    // value — it must never be certified absent (it DOES occur) either.
    expect(fullChainText(result.hops)).not.toContain("request-item-absent:MAX_QUOTA_UNITS");
  }, 60_000);

  it("the identifier asked alone (no real symbol in the query): still terminates honestly with no repeat", async () => {
    const ws = buildWorkspace("alone", { fnName: "checkQuota", term: "MAX_QUOTA_UNITS", docs: 2 });
    const server = await spawnedServer(ws);
    const result = await runChain(server, ws, "MAX_QUOTA_UNITS の値を教えてください。");

    expect(result.capped, `bare-identifier chain did not settle within 8 hops: ${JSON.stringify(result.hops.map((h) => h.call))}`).toBe(false);
    assertNoRepeatedNext(result.hops);
    assertEachServedBodyIsNew(result.hops);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Unit-level probes of the fix itself: `buildTaskExecutionContract`'s
// undeclared-identifier recovery, exercised directly against a hand-seeded
// served-range ledger (state/session.ts) — no server spawn, no facet-plan
// machinery in the way, so the sha-staleness rule is checked in isolation.
// ---------------------------------------------------------------------------

describe("WP-M unit probes: computeUndeclaredIdentifierReadCall judges 'served' against the task's ledger, not this call's own surfaces", () => {
  function twoDocWorkspace(tag: string, term: string): string {
    const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-discprog-unit-${tag}-`));
    tmpDirs.push(ws);
    write(ws, "package.json", "{}\n");
    write(ws, "src/other.ts", "export function other(): number {\n  return 1;\n}\n");
    write(ws, "docs/incident-report.md", DOC_BUILDERS[0]!(term));
    write(ws, "docs/ops-notes.md", DOC_BUILDERS[1]!(term));
    return ws;
  }

  function answerResult(): TaskPackResult {
    return {
      mode: "task_pack",
      coverage: "partial",
      coverage_reason: "concerns-uncovered",
      missing: [],
      route: { action: "locate_missing_surfaces", max_additional_tl_calls: 1 },
      surfaces: [{ role: "domain", handle: "h-other", path: "src/other.ts", range: "1-3", required: true, code: "export function other(): number {\n  return 1;\n}\n" }],
    } as unknown as TaskPackResult;
  }

  function nextTargetPath(ws: string, query: string): string | undefined {
    const contract = buildTaskExecutionContract(answerResult(), "answer", query, undefined, ws);
    const args = contract.next_call?.arguments as { targets?: Array<{ path: string }> } | undefined;
    return args?.targets?.[0]?.path;
  }

  it("a candidate served at an OLDER sha still counts as unserved (a real external edit must keep re-serving, never skip to search)", () => {
    const term = "MAX_QUOTA_UNITS_STALE";
    const ws = twoDocWorkspace("stale", term);
    const query = `Explain how ${term} is used.`;

    const first = nextTargetPath(ws, query);
    expect(first, "no candidate path proposed on a fresh workspace").toBeDefined();
    const chosenPath = first!;
    const abs = path.join(ws, chosenPath);
    const totalLines = fs.readFileSync(abs, "utf8").split("\n").length;

    // Seed a STALE claim: some OLD content's sha, not the file's current one.
    recordServedRange(ws, chosenPath, "sha256:" + "0".repeat(64), 1, totalLines, totalLines);
    settleServedRanges(ws, { unattributed: false, windows: [{ path: chosenPath, start: 1, end: totalLines }] });

    const afterStaleSeed = nextTargetPath(ws, query);
    expect(afterStaleSeed, "a stale-sha ledger entry wrongly suppressed the candidate").toBe(chosenPath);
  });

  it("a candidate served at its CURRENT sha is correctly recognized, and the OTHER candidate is offered next (progress, no repeat)", () => {
    const term = "MAX_QUOTA_UNITS_FRESH";
    const ws = twoDocWorkspace("fresh", term);
    const query = `Explain how ${term} is used.`;

    const first = nextTargetPath(ws, query);
    expect(first).toBeDefined();
    const chosenPath = first!;
    const otherPath = chosenPath === "docs/incident-report.md" ? "docs/ops-notes.md" : "docs/incident-report.md";
    const abs = path.join(ws, chosenPath);
    const content = fs.readFileSync(abs, "utf8");
    const totalLines = content.split("\n").length;
    const sha = shaOfText(content);

    recordServedRange(ws, chosenPath, sha, 1, totalLines, totalLines);
    settleServedRanges(ws, { unattributed: false, windows: [{ path: chosenPath, start: 1, end: totalLines }] });

    const second = nextTargetPath(ws, query);
    expect(second, `served candidate ${chosenPath} was re-offered instead of advancing to ${otherPath}`).toBe(otherPath);

    // Now mark the SECOND candidate served too (both exhausted) — no more
    // tl_read_file target should be offered for either mention site.
    const abs2 = path.join(ws, otherPath);
    const content2 = fs.readFileSync(abs2, "utf8");
    const totalLines2 = content2.split("\n").length;
    recordServedRange(ws, otherPath, shaOfText(content2), 1, totalLines2, totalLines2);
    settleServedRanges(ws, { unattributed: false, windows: [{ path: otherPath, start: 1, end: totalLines2 }] });

    const third = nextTargetPath(ws, query);
    expect(third, `both candidates were served, yet a tl_read_file target was still offered: ${third}`).toBeUndefined();
  });

  it("recall control: a fresh workspace with no ledger entries behaves exactly as before this fix (first candidate still proposed)", () => {
    const term = "MAX_QUOTA_UNITS_RECALL";
    const ws = twoDocWorkspace("recall", term);
    const query = `Explain how ${term} is used.`;

    const contract = buildTaskExecutionContract(answerResult(), "answer", query, undefined, ws);
    expect(contract.next_call?.tool).toBe("tl_read_file");
    const args = contract.next_call?.arguments as { targets?: Array<{ path: string; range?: string }> };
    expect(args.targets).toHaveLength(1);
    expect(["docs/incident-report.md", "docs/ops-notes.md"]).toContain(args.targets![0]!.path);
  });
});
