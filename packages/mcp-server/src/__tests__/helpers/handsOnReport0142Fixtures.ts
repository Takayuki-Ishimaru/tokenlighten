/**
 * handsOnReport0142Fixtures.ts — synthetic workspace builders for
 * `handsOnReport0142.characterization.spec.ts`, the FAIL-FIRST reproduction
 * harness for the v0.14.2 external evaluation follow-up (see
 * `scratchpad/report-0142.md` §4/§5, and `scratchpad/brief-common.md` for the
 * item table). The evaluator's own ZIP (logs/*.jsonl, reproduce.py,
 * *-results.json) was NOT provided to this wave — only the report text —
 * so all workspaces here are reconstructions from the report's own prose,
 * not a byte-exact replay of the evaluator's fixture.
 *
 * A THIRD builder, `buildVsixEraExtensionWorkspace()`, was added in the
 * 2026-09-13 fix wave (F3) — see its own doc comment below for why
 * `buildRealExtensionWorkspace()`'s CURRENT-HEAD file sizes cannot reproduce
 * TL142-03.
 *
 * Two builders:
 *
 * - `buildEvalWorkspace()` — the report's "手製のTypeScriptフィクスチャ"
 *   (§1: "手製のTypeScriptフィクスチャに加え...実際の拡張機能src..."): a small
 *   synthetic TS package with `validateToken` (TL142-01A/01B/04),
 *   `MAX_RETRIES` (TL142-01A/02/04), and `DEFAULT_TTL_MS` (TL142-02/04).
 *   Deliberately small (each file's whole-file surface is reachable in one
 *   response — see `handsOnReportFixtures.ts`'s own CACHE_TS comment for why
 *   file size is load-bearing, not incidental, for this class of fixture) so
 *   a case's own assertions are about the PROTOCOL's behaviour, not about an
 *   incidental budget cut. Deliberately does NOT contain `src/new-config.ts`
 *   — TL142-01C's own query creates that file, and a case asserting on
 *   "does this workspace already have it" would be meaningless if the
 *   fixture pre-seeded it.
 *
 * - `buildRealExtensionWorkspace()` — the report's real-extension condition
 *   (§1: "取得したVSIXに含まれる実際の拡張機能src、package.json、
 *   readme.mdを使った", TL142-03/05's own fixture). Copies verbatim, at
 *   fixture-BUILD time (not vendored), the exact files
 *   `scratchpad/brief-common.md`'s "Key code locations" section names for
 *   this wave: `src/mcpProvider.ts`, `src/generated/schemaStamp.ts`,
 *   `src/diagnosticsPanel.ts`, `src/sidebar.ts`, `src/extension.ts`,
 *   `src/commands.ts`, `package.json`, and `README.md` written as the
 *   lowercase `readme.md` — the exact filename casing inside the real VSIX
 *   (the evaluator's own report never reads the extension's OWN in-repo
 *   README.md path; it reads what ships inside the packaged VSIX).
 *
 *   IMPORTANT SIZE CAVEAT (brief-common.md's "Key code locations" section):
 *   `src/mcpProvider.ts` on current `develop` HEAD is 11,456 B; the report's
 *   own numbers (§4 TL142-05: "指定した2ファイルは合計9,007 B") were measured
 *   against the v0.14.2-tagged VSIX's OWN copy of that file, which is only
 *   8,276 B (`8,276 + schemaStamp.ts's 731 = 9,007`, exactly the report's
 *   figure). `develop` has grown that file by ~3,180 B since the v0.14.2 tag
 *   (a real local v0.14.2 git tag was not available to re-derive this
 *   independently in this session; the 8,276 B figure is taken as given from
 *   the orchestrator's pre-scouting). This file intentionally copies
 *   CURRENT HEAD's version, not the historical VSIX-era one — this harness
 *   reproduces against "CURRENT develop HEAD" per this wave's own task
 *   framing, not against the v0.14.2 tag the evaluator actually drove — so
 *   every byte-budget assertion in the companion spec computes its cap from
 *   the ACTUAL on-disk size of the files THIS builder just wrote (via
 *   `fs.statSync`), never from the report's own historical byte counts.
 *
 * Cleanup is the SPEC's responsibility (its own `useCaseServer`/`afterAll`),
 * mirroring `handsOnReportFixtures.ts` — these builders only create.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { freshWorkspace, writeFile } from "./handsOnReportFixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** helpers/ -> __tests__/ -> src/ -> mcp-server/ -> packages/ -> repo root. */
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");

const MINIMAL_PACKAGE_JSON = JSON.stringify(
  { name: "tl-hands-on-0142-fixture", version: "0.0.1", private: true, type: "module" },
  null,
  2,
) + "\n";

const MINIMAL_TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ES2022",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      outDir: "dist",
    },
    include: ["src"],
  },
  null,
  2,
) + "\n";

/**
 * TL142-01A/01B/04's target. ~30 real lines (interfaces + one short JSDoc +
 * `validateToken`), LF-terminated. The expiry check is the explicit
 * `payload.exp <= now` form the task brief asks for — this is deliberately
 * NOT a planted defect (unlike `handsOnReportFixtures.ts`'s CACHE_TS): every
 * TL142-01/04 query about this file is an EXPLAIN/DESCRIBE query, not an
 * edit query, so there is nothing here for a fix to target.
 */
const AUTH_TS = `export interface TokenPayload {
  sub: string;
  exp: number;
}

export interface TokenValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Validates a decoded token payload against the current time.
 *
 * @param payload - the decoded token payload (must include \`exp\`, a
 *   unix-seconds expiry timestamp)
 * @param now - the current unix-seconds time to check against
 * @returns \`{ ok: true }\` when the token is still valid, or
 *   \`{ ok: false, reason }\` naming why it was rejected
 */
export function validateToken(payload: TokenPayload, now: number): TokenValidation {
  if (payload == null) {
    return { ok: false, reason: "missing-payload" };
  }
  if (typeof payload.exp !== "number") {
    return { ok: false, reason: "missing-exp" };
  }
  if (payload.exp <= now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return { ok: false, reason: "missing-subject" };
  }
  return { ok: true };
}
`;

/** TL142-01A/02/04's `MAX_RETRIES` target, plus a small consumer using it (~16 lines). */
const RETRY_TS = `export const MAX_RETRIES = 3;

/**
 * Calls \`fn\`, retrying up to MAX_RETRIES times when it throws.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

/** TL142-02/04's `DEFAULT_TTL_MS` target, plus a small Cache class using it (~25 lines). */
const CACHE_TS = `export const DEFAULT_TTL_MS = 60000;

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class Cache<V = unknown> {
  private readonly entries = new Map<string, CacheEntry<V>>();

  set(key: string, value: V, ttlMs: number = DEFAULT_TTL_MS, now: number = Date.now()): void {
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  clear(): void {
    this.entries.clear();
  }
}
`;

/**
 * The first line of `validateToken`'s doc comment in `AUTH_TS` —
 * `buildEvalWorkspaceLarge` splices its filler block in immediately above it.
 * A constant rather than an inline literal so a future edit to `AUTH_TS`'s
 * comment breaks the splice loudly (the replace becomes a no-op and the
 * fixture's own size assertion in the spec fails) instead of silently
 * producing a workspace that no longer reproduces anything.
 */
const VALIDATE_TOKEN_DOC_ANCHOR = "/**\n * Validates a decoded token payload";

/** Unrelated exported helpers spliced above `validateToken` (~8 lines each). */
const LARGE_AUTH_HELPER_COUNT = 20;
/** Same-token candidate files competing for the first pack's byte budget. */
const LARGE_HANDLER_COUNT = 40;

const INDEX_TS = `export * from "./auth.js";
export * from "./retry.js";
export * from "./cache.js";
`;

/**
 * The report's "手製のTypeScriptフィクスチャ" (§1) for TL142-01A/01B/01C/02/04:
 * `validateToken` (auth.ts), `MAX_RETRIES` (retry.ts), `DEFAULT_TTL_MS`
 * (cache.ts), and an `index.ts` re-export barrel. Deliberately NO
 * `src/new-config.ts` — TL142-01C's own creation query targets that path,
 * and it must not already exist.
 */
export function buildEvalWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-eval");
  writeFile(dir, "package.json", MINIMAL_PACKAGE_JSON);
  writeFile(dir, "tsconfig.json", MINIMAL_TSCONFIG_JSON);
  writeFile(dir, "src/auth.ts", AUTH_TS);
  writeFile(dir, "src/retry.ts", RETRY_TS);
  writeFile(dir, "src/cache.ts", CACHE_TS);
  writeFile(dir, "src/index.ts", INDEX_TS);
  return { dir };
}

/**
 * The review round's (2026-09-13) ledger-honesty workspaces — one builder, four
 * variants, all deliberately TINY: each case is about what the executed-search
 * ledger may RECORD and PROMOTE, so the only properties that matter are where
 * the second identifier lives and whether the scan can see it.
 *
 * Reconstructed byte-for-byte from the adversarial reviewer's own probe
 * workspaces (`scratchpad/rev-ws-abs`, `rev-ws-abs2`, `rev-ws-prose`), so the
 * inputs that produced the false certificates are the inputs these cases drive:
 *
 *  - `"ignored"`   — the term IS in the workspace, under a `.tokenlightenignore`d
 *                    path. The find's own certificate carries a `caveat` and the
 *                    body discloses `omitted:{tokenlighten_ignored:1}`, while a
 *                    per-term verdict in a MIXED batch still reads
 *                    `scope.completeness:"complete"`. Nothing may be recorded.
 *  - `"unreadable"`— the involuntary-exclusion variant: the term is in a mode-000
 *                    file, which no user chose to exclude and which the response
 *                    discloses in NEITHER `omitted` nor `caveat`. Nothing may be
 *                    recorded (the whole-set certificate is what is required, and
 *                    a mixed batch has none). POSIX only — the spec skips it where
 *                    a chmod cannot make a file unreadable.
 *  - `"prose"`     — the term occurs ONLY in markdown prose, in a sentence that
 *                    says it is not implemented. A hit, but not code — so it may
 *                    not be promoted as that identifier's surface.
 *  - `"clean"`     — the control: nothing excluded, nothing unreadable, and the
 *                    two absent identifiers really are absent. The caveat-free
 *                    whole-set certificate MUST still be recorded and certified,
 *                    otherwise the honesty gates have simply deleted the feature.
 *  - `"html"`      — R2-B13 (review round 2, `scratchpad/r2-ws-html`): the SAME
 *                    sentence as `"prose"`, moved into an HTML `<!-- ... -->`
 *                    comment in `src/page.html`. `.html` is in no prose list and
 *                    `util/lineClassify.ts` had never been taught `<!-- -->`, so
 *                    round 1's gate waved it through and the false certificate
 *                    returned verbatim. Same requirement as `"prose"`.
 */
export function buildLedgerHonestyWorkspace(
  variant: "ignored" | "unreadable" | "prose" | "clean" | "html",
): { dir: string } {
  const dir = freshWorkspace(`0142-honesty-${variant}`);
  writeFile(dir, "package.json", MINIMAL_PACKAGE_JSON);
  writeFile(dir, "tsconfig.json", MINIMAL_TSCONFIG_JSON);
  writeFile(dir, "src/auth.ts", AUTH_TS);
  if (variant === "ignored") {
    writeFile(dir, ".tokenlightenignore", "vendor/\n");
    writeFile(dir, "vendor/legacy.ts", `// Legacy vendored module, excluded from TokenLighten scans.
export const quantumTeleportationMode = "enabled";
export function useQuantumTeleportationMode(): string {
  return quantumTeleportationMode;
}
`);
  }
  if (variant === "unreadable") {
    writeFile(dir, "src/locked.ts", `export const quantumTeleportationMode = "enabled";\n`);
    fs.chmodSync(path.join(dir, "src/locked.ts"), 0o000);
  }
  if (variant === "prose") {
    writeFile(dir, "docs/notes.md", `# Operations notes

We once considered adding a quantumTeleportationMode flag to the retry layer,
but the RFC was withdrawn. Do not rely on quantumTeleportationMode: it is not
implemented anywhere in this codebase.
`);
  }
  if (variant === "html") {
    // R2-B13: the reviewer's own `r2-ws-html/src/page.html`, byte-for-byte.
    writeFile(dir, "src/page.html", `<div class="panel">
  <!-- Do not rely on quantumTeleportationMode: it is not implemented anywhere in this codebase. -->
  <span>status</span>
</div>
`);
  }
  return { dir };
}

/**
 * BLOCKER 12 (2026-09-13 review round 3): the reviewer's own
 * `scratchpad/r2-ws-weak2`, byte-for-byte — a workspace with NO strong
 * evidence anywhere: `src/theme.css` matches a query only lexically (a CSS
 * comment/selector sharing ordinary English words), and `src/locked.ts` is
 * chmod 000 (present in both the default and query-named-file walks, but
 * unreadable). `buildAnswerTaskPack`'s named-path relation gate
 * (`gateAnswerQueryEvidenceFocusOnNamedPathRelation`) used to splice away
 * theme.css's own weak `answer-query-evidence-focus` surface with no "never
 * drop the last surviving surface" floor — unlike the pathless branch, this
 * branch's usual invariant (augmentQueryNamedFileSurfaces guarantees at
 * least one required named-file surface before the gate ever runs) does not
 * hold when the named path resolves but cannot be READ, so the pack's ONLY
 * surface was removed and `surfaces[0]!.range` threw a few lines later — a
 * bare JSON-RPC error, no `v:1` envelope. POSIX only: the spec skips this
 * where a chmod cannot make a file unreadable (Windows, or running as root).
 */
export function buildWeakNamedUnreadableWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-weak-named-unreadable");
  writeFile(dir, "package.json", '{"name":"weak2"}\n');
  writeFile(dir, "src/theme.css", `/* refresh cycle for cached definitions in the panel */
.panel {
  display: flex;
  margin: 0;
}
.panel h1 {
  font-size: 14px;
}
.row {
  padding: 2px;
}
.cached-definitions {
  color: red;
}
`);
  writeFile(dir, "src/locked.ts", `export const cachedDefinitionsRefreshCycle = () => {};\n`);
  fs.chmodSync(path.join(dir, "src/locked.ts"), 0o000);
  return { dir };
}

/**
 * SHOULD-FIX 36 / finding 32(b) (2026-09-14, review round 5): the SAME
 * `buildWeakNamedUnreadableWorkspace` shape, but the query also names a
 * second, genuinely-absent identifier ("QuoteOrchestrator") so the FIRST
 * pack's decision is `discover`-shaped (a real, OTHER bounded call remains —
 * the identifier search — alongside the unreadable-named-path disclosure)
 * rather than `await_input`-shaped. This is the input that exposed finding
 * 32(b)'s full symptom: on a `discover`-shaped re-pack, the WHOLE
 * `decision.gaps` array went silent (`gaps: null`) — not merely the
 * unreadable-named-path row finding 36 names, but the co-resident, unrelated
 * "surface-content"/identifier gap too — because `compactReceiptFromRecord`
 * never restated `TaskExecutionContract.capability_gaps` at all
 * (`decisionWire.ts::projectGaps` reads only `contract.capability_gaps`, a
 * DIFFERENT field than the `unreadable_named_paths` restatement alone can
 * feed). The workspace itself is otherwise byte-identical to
 * `buildWeakNamedUnreadableWorkspace` (same theme.css, same chmod-000
 * locked.ts) — only the QUERY differs between the two fixtures' own
 * describes.
 */
export function buildUnreadableNamedPlusIdentifierWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-weak-named-unreadable-plus-identifier");
  writeFile(dir, "package.json", '{"name":"weak2"}\n');
  writeFile(dir, "src/theme.css", `/* refresh cycle for cached definitions in the panel */
.panel {
  display: flex;
  margin: 0;
}
.panel h1 {
  font-size: 14px;
}
.row {
  padding: 2px;
}
.cached-definitions {
  color: red;
}
`);
  writeFile(dir, "src/locked.ts", `export const cachedDefinitionsRefreshCycle = () => {};\n`);
  fs.chmodSync(path.join(dir, "src/locked.ts"), 0o000);
  return { dir };
}

/**
 * BLOCKER 25 (2026-09-14, review round 4): the reviewer's own
 * `scratchpad/r3-ws-bin`, byte-for-byte — the SAME shape as
 * `buildWeakNamedUnreadableWorkspace` above, with the one difference that makes
 * the finding platform-independent: `src/locked.ts` is unreadable because its
 * BYTES ARE NOT TEXT (one NUL after the declaration, so `decodeTextBuffer`
 * returns null), not because of a chmod. So this fixture reproduces on Windows
 * and as root too, and it is the variant that shipped `task.coverage:"complete"`
 * while hiding a file the query named.
 *
 * The NUL is written via a `\u0000` ESCAPE, never a literal NUL byte in this
 * source file (the repo's own byte hygiene forbids one).
 */
export function buildUndecodableNamedWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-undecodable-named");
  writeFile(dir, "package.json", '{"name":"weak2"}\n');
  writeFile(dir, "src/theme.css", `/* refresh cycle for cached definitions in the panel */
.panel {
  display: flex;
  margin: 0;
}
.panel h1 {
  font-size: 14px;
}
.row {
  padding: 2px;
}
.cached-definitions {
  color: red;
}
`);
  writeFile(
    dir,
    "src/locked.ts",
    "export const cachedDefinitionsRefreshCycle = () => {};\n\u0000// binary marker\n",
  );
  return { dir };
}

/**
 * SHOULD-FIX 35 (2026-09-14, review round 5): four `src/locked.ts` variants
 * exercising `classifyLenientText`'s threshold at the SAME query-named-file
 * augmentation call site `buildUndecodableNamedWorkspace` above exercises
 * (`readCodeTaskPack.ts::augmentQueryNamedFileSurfaces`). Each variant carries
 * the SAME byte-identical `src/theme.css` sibling `buildUndecodableNamedWorkspace`
 * uses (never just the one ambiguous-encoding file alone) — measured, not
 * assumed: a single-file workspace lets a DIFFERENT, earlier candidate-
 * discovery pass (`why:"filename-match"`) claim `src/locked.ts` before this
 * augmentation ever runs (`already.has(rel)` then short-circuits it — the
 * pre-existing, orthogonal gap review-findings-5.md's own NOTE 38 names,
 * out of this finding's scope), so it never reaches `readNamedFileTextLenient`/
 * `classifyLenientText` at all and every assertion below would be vacuous.
 *
 *   - `"utf16le-no-bom"` — the finding's own primary repro: a real UTF-16LE
 *     save with NO BOM, the Windows `.ps1`/`.bat` default `decodeTextBuffer`
 *     exists to refuse. Lenient-decoding this as UTF-8 interleaves a NUL
 *     after every ASCII-range code unit (~50% NUL density) — the review's
 *     own "126 chars containing 63 literal NUL bytes" shape.
 *   - `"utf16le-bom"` / `"utf8-bom"` — controls: a RECOGNIZED BOM means
 *     `decodeTextBuffer` (strict) already succeeds, so `readCached` never
 *     fails and this augmentation's lenient fallback is never even consulted
 *     — these must keep serving exactly as any other named file always has.
 *   - `"rare-nul-stripped"` — the SAME single incidental NUL
 *     `buildUndecodableNamedWorkspace` uses, but padded well past the
 *     `MIN_NUL_FREE_RATIO` (99%) threshold, so this is the fixture that
 *     actually exercises the "serve NUL-stripped, `why` noting it" branch —
 *     `buildUndecodableNamedWorkspace`'s own 73-byte file is BELOW the
 *     threshold (98.6% NUL-free) and correctly lands on the "disclose"
 *     branch instead (see that fixture's own describe, updated for this
 *     finding).
 */
export function buildLenientDecodeWorkspace(
  variant: "utf16le-no-bom" | "utf16le-bom" | "utf8-bom" | "rare-nul-stripped"
    // AA1 (2026-09-14, review round 10) -- the three verdicts the ONE serve-side
    // decode policy (util/textDecode.ts::readServedText) draws that no earlier
    // round's predicate could:
    //  - "nul-past-4096": review round 9's finding 49/50 fixture. The first NUL
    //    sits at byte ~4260, PAST `UNDECODABLE_PROBE_BYTES`, so the old 4 KB NUL
    //    probe called the buffer decodable and the counterexample route shipped
    //    300 escaped NULs inside a certified `act.answer` while the seeded door
    //    called the SAME file "unreadable". Round 9 named this pin missing.
    //  - "invalid-utf8-heavy": finding 51's Shift-JIS save read as UTF-8 -- 80
    //    U+FFFD in 127 bytes. Strict decode refuses the bytes, so no ratio has
    //    to be guessed and no door certifies over mojibake.
    //  - "latin1": one 0xE9 byte in an otherwise-ASCII file. Rounds 5-9 SERVED
    //    this ("strict" meant only "no NUL in the first 4 KB"); under true strict
    //    UTF-8 it is `invalid-encoding` and is DISCLOSED. That is round 10's one
    //    deliberate, documented behavior trade -- see readServedText's own
    //    comment.
    | "nul-past-4096" | "invalid-utf8-heavy" | "latin1",
): { dir: string } {
  const dir = freshWorkspace(`0142-lenient-${variant}`);
  writeFile(dir, "package.json", '{"name":"lenient-decode"}\n');
  writeFile(dir, "src/theme.css", `/* refresh cycle for cached definitions in the panel */
.panel {
  display: flex;
  margin: 0;
}
.panel h1 {
  font-size: 14px;
}
.row {
  padding: 2px;
}
.cached-definitions {
  color: red;
}
`);
  const abs = path.join(dir, "src/locked.ts");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const DECL = "export const cachedDefinitionsRefreshCycle = () => {};\n// wide\n";
  if (variant === "utf16le-no-bom") {
    fs.writeFileSync(abs, Buffer.from(DECL, "utf16le"));
  } else if (variant === "utf16le-bom") {
    fs.writeFileSync(abs, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(DECL, "utf16le")]));
  } else if (variant === "utf8-bom") {
    fs.writeFileSync(abs, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(DECL, "utf8")]));
  } else if (variant === "nul-past-4096") {
    // 4 KB of ordinary comment text, the declaration, then a NUL-interleaved
    // tail: strict UTF-8 ACCEPTS every byte (U+0000 is a legal codepoint), so
    // only the whole-buffer NUL DENSITY rule can refuse it.
    const content = "// " + "a".repeat(4200) + "\n"
      + "export const cachedDefinitionsRefreshCycle = () => {};\n"
      + ("x" + String.fromCharCode(0)).repeat(300);
    fs.writeFileSync(abs, Buffer.from(content, "utf8"));
  } else if (variant === "invalid-utf8-heavy") {
    fs.writeFileSync(abs, Buffer.concat([
      Buffer.from("// export const cachedDefinitionsRefreshCycle\n", "utf8"),
      // 0x93/0xFA pairs: valid Shift-JIS, never valid UTF-8.
      Buffer.from(Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0x93 : 0xfa))),
      Buffer.from("\n"),
    ]));
  } else if (variant === "latin1") {
    fs.writeFileSync(abs, Buffer.concat([
      Buffer.from("export const cachedDefinitionsRefreshCycle = () => {}; // caf", "utf8"),
      Buffer.from([0xe9]),
      Buffer.from("\n"),
    ]));
  } else {
    const padding = "// padding line kept well clear of the declaration below\n".repeat(20);
    const content = padding
      + "export const cachedDefinitionsRefreshCycle = () => {};\n"
      + String.fromCharCode(0)
      + "// binary marker\n"
      + padding;
    fs.writeFileSync(abs, Buffer.from(content, "utf8"));
  }
  return { dir };
}

/**
 * SHOULD-FIX 58 (AB1, 2026-09-14, review round 11) — THE WORKSPACE SHAPE THAT
 * DECIDED WHETHER A CALLER WAS TOLD THE REASON.
 *
 * `buildLenientDecodeWorkspace` happens to take the AUGMENTATION path, so the
 * round-10 block's `expect(disclosures).toContain("undecodable")` passed. Round
 * 10's own probe, and AA1's own `aa1-doors-final.log`, both exhibit the other
 * shape: a 2-file workspace where ONLY the undecodable file carries the queried
 * symbol, so the literal-first single-file binder surfaces it FIRST and
 * `augmentQueryNamedFileSurfaces` skips the disclosure (`already.has(rel)`),
 * leaving `evidence:[{why:"filename-match", len:0}]` with no reason anywhere on
 * the response and a prescribed `next` that refuses.
 *
 * The undecodable file's only invalid byte sits INSIDE A COMMENT (the brief's own
 * "a file whose only invalid byte is in a comment" attack), so nothing about the
 * declaration itself is malformed — the refusal is a property of the bytes, and
 * the disclosure must be a property of the verdict rather than of which reader
 * happened to see the path first.
 */
export function buildCommentBytePrimarySymbolWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-commentbyte-primary");
  writeFile(dir, "package.json", '{"name":"commentbyte-primary"}\n');
  // A sibling that does NOT name the symbol, so the locator's single best
  // candidate is the undecodable file itself.
  writeFile(dir, "src/theme.css", "/* panel styling only */\n.panel { display: flex; }\n");
  const abs = path.join(dir, "src/commentbyte.ts");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.concat([
    Buffer.from("export const cachedDefinitionsRefreshCycle = () => {};\n// caf", "utf8"),
    Buffer.from([0xe9]),
    Buffer.from(" latte\n", "utf8"),
  ]));
  return { dir };
}

/**
 * SHOULD-FIX 37 (2026-09-14, review round 7): the review's own "ORDINARY
 * workspace" repro for the SEEDED-TARGETS door — `buildLenientDecodeWorkspace
 * ("rare-nul-stripped")`'s own two-file shape (`src/theme.css` +
 * `src/locked.ts`) does NOT reproduce this: a query naming an absent
 * identifier there degrades to a bare `search_files find` `next` (measured),
 * never a `qref`+`targets` read re-pack, so it never re-enters
 * `buildSeededTaskPack`'s explicit-`targets` read loop a second time. THIS
 * workspace adds two well-formed siblings (`src/panel.ts`, matching the
 * query lexically enough to become the identifier search's best candidate;
 * `src/cache.ts`, additive noise matching the review's own fixture) so the
 * first pack's `discover` decision instead prescribes a `next` that BUNDLES
 * `src/locked.ts` alongside `src/panel.ts` in one `targets:[...]` re-pack —
 * the one shape that actually drives the seeded-targets door a second time
 * for this file. `src/locked.ts` carries the SAME rare-nul-stripped bytes
 * `buildLenientDecodeWorkspace("rare-nul-stripped")` uses (one incidental
 * NUL, padded past `MIN_NUL_FREE_RATIO`).
 */
export function buildSeededDoorNulStrippedWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-seeded-door-nul-stripped");
  writeFile(dir, "package.json", '{"name":"lenient-decode"}\n');
  writeFile(
    dir,
    "src/panel.ts",
    "// refresh cycle for cached definitions in the panel\nexport function refreshCachedDefinitions(): void {}\n",
  );
  writeFile(
    dir,
    "src/cache.ts",
    "// cached definitions live here; the refresh cycle reads them\nexport const cachedDefinitions = new Map<string, string>();\n",
  );
  writeFile(
    dir,
    "src/theme.css",
    "/* refresh cycle for cached definitions in the panel */\n.cached-definitions { color: red; }\n",
  );
  const padding = "// padding line kept well clear of the declaration below\n".repeat(20);
  const content = padding
    + "export const cachedDefinitionsRefreshCycle = () => {};\n"
    + String.fromCharCode(0)
    + "// binary marker\n"
    + padding;
  writeFile(dir, "src/locked.ts", content);
  return { dir };
}

/**
 * BLOCKER 40 (2026-09-14, review round 8): a file whose STRICT decode
 * SUCCEEDS -- no BOM needed, no raw NUL anywhere -- but whose content
 * happens to contain a literal U+FFFD character (e.g. pasted from a source
 * that used the replacement character deliberately). `decodeTextBuffer`'s
 * only failure mode is a raw NUL within the first UNDECODABLE_PROBE_BYTES
 * bytes (see util/textDecode.ts), so this buffer decodes cleanly every
 * time; the query-named-file augmentation and a direct `targets:[{path}]`
 * slice never even reach `classifyLenientText` for it (their own strict
 * read already succeeds). `variant:"short"` is the review's own exact
 * 60-character repro (one U+FFFD, ratio 0.0167 -- ABOVE
 * MAX_REPLACEMENT_RATIO 0.01, so the seeded-targets door's OWN
 * `classifyLenientText` call, run unconditionally before this fix, judged
 * it "undecodable"); `variant:"padded"` is the SAME content padded to 273
 * characters (ratio 0.0037, comfortably below the threshold) -- proving the
 * bug tracked the RATIO, not the content, since only the short variant used
 * to be refused.
 */
export function buildLiteralFffdWorkspace(variant: "short" | "padded"): { dir: string } {
  const dir = freshWorkspace(`0142-literal-fffd-${variant}`);
  writeFile(dir, "package.json", '{"name":"literal-fffd"}\n');
  writeFile(
    dir,
    "src/theme.css",
    "/* refresh cycle for cached definitions in the panel */\n.cached-definitions { color: red; }\n",
  );
  const short = "export const cachedDefinitionsRefreshCycle = () => {}; // �\n";
  const content = variant === "short" ? short : short + "x".repeat(273 - short.length);
  writeFile(dir, "src/fffd.ts", content);
  return { dir };
}

/**
 * BLOCKER 30 (2026-09-14, review round 4): the reviewer's own
 * `scratchpad/r4-ws-ui`, byte-for-byte — three files, nothing else.
 * `src/components/settings.ts` and `src/components/Panel.tsx` both live under
 * a `/component` path segment (and `Panel.tsx` also matches the `.tsx`
 * extension) — `util/impact.ts::classifySurface` classifies BOTH as `"ui"` —
 * while `src/core/settings.ts` is byte-for-byte the same SHAPE of file (an
 * exported const object literal with one property) under a path
 * `classifySurface` does not special-case. Before the fix, `identifier:` for
 * a property key/JSX prop in the two `/component` files was refused by
 * `pathClassCanCarryCode`'s `classifySurface`-class conjunct while the
 * `src/core/` control discharged — a directory-name heuristic deciding
 * code-bearing-ness, not the bytes.
 */
export function buildDirectorySegmentSurfaceWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-directory-segment-surface");
  writeFile(dir, "package.json", '{"name":"r4-ws-ui"}\n');
  writeFile(dir, "src/components/settings.ts", "export const componentSettings = {\n  retryBudgetMs: 250,\n};\n");
  writeFile(dir, "src/core/settings.ts", "export const coreSettings = {\n  idleSweepMs: 500,\n};\n");
  writeFile(
    dir,
    "src/components/Panel.tsx",
    "export function Panel(props: { dataTestId: string }): string { return props.dataTestId; }\n",
  );
  return { dir };
}

/**
 * R2-B14 (2026-09-13 review round 2): the reviewer's own `scratchpad/r1-ws-ctl`,
 * byte-for-byte — `package.json` plus a SEVEN-LINE `src/auth.ts`.
 *
 * `buildLedgerHonestyWorkspace("clean")` cannot stand in for it: its `AUTH_TS`
 * is the 34-line TL142-01A target, and with that file present the post-create
 * rebuild reaches `discover` for unrelated readiness reasons — so a case built on
 * it passes whether or not the absence is re-validated (verified: with every
 * R2-B13/R2-B14 gate neutralized, the "clean" fixture's step 6 is already
 * `discover` while this fixture's step 6 is the reported false certificate).
 * The whole point of the case is that one response served `src/quantum.ts` and
 * certified that identifier absent, so the fixture has to be the one that does it.
 */
export function buildAbsenceRevalidationWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-absence-revalidation");
  writeFile(dir, "package.json", '{"name":"r1-ctl","version":"0.0.0"}\n');
  writeFile(dir, "src/auth.ts", `export interface TokenPayload { sub: string; exp: number }

/** Validates a token and checks its expiry window. */
export function validateToken(payload: TokenPayload, now: number): boolean {
  if (payload.exp <= now) return false;
  return payload.sub.length > 0;
}
`);
  return { dir };
}

/**
 * R2-B13 (2026-09-13 review round 2): the non-markup carriers of the SAME hole.
 *
 * `.html` was the reported instance; the cause was `util/lineClassify.ts`'s
 * `default: []` reading as "this language has no comments" for every language it
 * had never learned. These three are the other reachable spellings, each with the
 * identifier ONLY inside a comment, plus the positive control:
 *
 *  - `src/schema.sql`   — `--` comment. `classifySurface` says `"data"`, so no
 *                         surface-class rule refuses it; the LANGUAGE conjunct
 *                         must ( `.sql` is unmapped by `languageForPath`).
 *  - `src/settings.ini` — `;` comment. `classifySurface` says `"unknown"`, which
 *                         is deliberately NOT refused (it is also the class of an
 *                         ordinary `src/auth.ts`), so again only the language
 *                         conjunct can close it.
 *  - `src/plugin.zzz`   — an extension nothing maps, holding what LOOKS like a
 *                         real declaration: an unknown language must never count
 *                         as code even when the text is not a comment at all.
 *  - `src/wired.py`     — the positive control: a genuine Python declaration in a
 *                         language the table DOES know, which must still be
 *                         promoted, and `src/commented.py` whose only occurrence
 *                         is behind `#`, which must not.
 */
export function buildCommentCarrierWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-comment-carriers");
  writeFile(dir, "package.json", MINIMAL_PACKAGE_JSON);
  writeFile(dir, "src/auth.ts", AUTH_TS);
  writeFile(dir, "src/schema.sql", `CREATE TABLE sessions (id TEXT PRIMARY KEY);
-- quantumTeleportationMode was never added to this schema.
`);
  writeFile(dir, "src/settings.ini", `[retry]
attempts = 3
; quantumTeleportationMode is not a supported key.
`);
  writeFile(dir, "src/plugin.zzz", `declare const quantumTeleportationMode = true;\n`);
  writeFile(dir, "src/wired.py", `PLASMA_CONDUIT_MODE = "on"\n\n\ndef plasmaConduitMode() -> str:\n    return PLASMA_CONDUIT_MODE\n`);
  writeFile(dir, "src/commented.py", `ATTEMPTS = 3\n# hyperLoopMode is not wired up yet.\n`);
  return { dir };
}

/**
 * Review round BLOCKER 5 (2026-09-13) — reconstructs the reviewer's own
 * `rev-ws-tiny` fixture: `src/a.ts` well under
 * `getSymbolWithContext.ts`'s `SMALL_FILE_SCOPE_HEADER_OMIT_BYTES` (2 KiB) so
 * its injected `// tokenlighten:scope ...` header is omitted, and
 * `src/big.ts` padded past that threshold with filler comments (header
 * kept) as the control — a `mode=symbol` read.text response's `path` field
 * must be populated either way.
 */
export function buildTinySymbolReadWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-tiny-symbol-read");
  writeFile(dir, "package.json", MINIMAL_PACKAGE_JSON);
  writeFile(dir, "tsconfig.json", MINIMAL_TSCONFIG_JSON);
  writeFile(
    dir,
    "src/a.ts",
    `export const GREETING = "hi";
export function add(a: number, b: number): number {
  return a + b;
}
`,
  );
  const bigFiller = Array.from(
    { length: 40 },
    () => "// filler comment line to push this file past the 2 KiB Trim A threshold\n",
  ).join("");
  writeFile(dir, "src/big.ts", `${bigFiller}export function add2(a: number, b: number): number {\n  return a + b;\n}\n`);
  return { dir };
}

/**
 * TL142-01A's own workspace (2026-09-13 fix wave).
 *
 * WHY A SECOND, LARGER WORKSPACE. `buildEvalWorkspace()` above is deliberately
 * tiny, and on it HEAD's locator places BOTH identifiers in the very first pack
 * — `act.answer`, no `next`, nothing to continue (wave 0 recorded 01A as
 * "could-not-reproduce" for exactly this reason). The report's sequence needs a
 * first pack that CANNOT place one of the two named identifiers and therefore
 * prescribes `search_files` for it; only then does the continuation the report
 * complains about exist at all. Three properties produce that state, and each
 * is load-bearing:
 *
 *  1. `src/auth.ts` is ~190 lines, with `validateToken` LAST, under 20
 *     unrelated exported helpers — so the pack's slice of it is a window, not
 *     the whole file, and `remaining_ranges` is non-empty (the report's own
 *     "既読readへ戻る" rotation needs a disclosed partial window to rotate
 *     through).
 *  2. `src/retry.ts` is a single line — the whole-file surface the report says
 *     the first pack returns.
 *  3. `src/handlers/h1..h40.ts` each import and call `validateToken`, so the
 *     locator has 40 strong same-token candidates competing for the pack's byte
 *     budget. This is what pushes the OTHER identifier out of the first pack;
 *     measured both ways — with the handlers referencing `MAX_RETRIES` instead
 *     the first pack resolves everything (`act.answer`, 3 evidence files, no
 *     `next`) and the case tests nothing, so the direction of the reference is
 *     load-bearing, not cosmetic.
 *
 * Measured against a real spawned server before being written (see
 * `scratchpad/fix-notes-1.md`): the first pack serves one identifier's owner
 * plus handler evidence, gaps the OTHER identifier, and prescribes a
 * `search_files` `next` for it — the report's step 1/2 exactly. On HEAD before
 * this wave the following resumes then rotated through an already-served
 * window (answering `read.receipt`) and a redundant re-search, never reaching
 * `act.answer`.
 */
export function buildEvalWorkspaceLarge(): { dir: string } {
  const dir = freshWorkspace("0142-eval-large");
  writeFile(dir, "package.json", MINIMAL_PACKAGE_JSON);
  writeFile(dir, "tsconfig.json", MINIMAL_TSCONFIG_JSON);

  const helpers: string[] = [];
  for (let i = 1; i <= LARGE_AUTH_HELPER_COUNT; i++) {
    helpers.push(`/** Unrelated helper #${i} — pads auth.ts so validateToken sits well past the first slice. */
export function unrelatedHelper${i}(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "empty-${i}";
  }
  return \`\${trimmed}-${i}\`;
}
`);
  }
  // The SAME auth.ts body as the small workspace, with the helper block spliced
  // in immediately above `validateToken`'s doc comment — so the symbol under
  // test is byte-identical between the two fixtures and only its POSITION (and
  // the file's size) differs.
  writeFile(
    dir,
    "src/auth.ts",
    AUTH_TS.replace(VALIDATE_TOKEN_DOC_ANCHOR, `${helpers.join("\n")}\n${VALIDATE_TOKEN_DOC_ANCHOR}`),
  );
  writeFile(dir, "src/retry.ts", "export const MAX_RETRIES = 3;\n");
  for (let i = 1; i <= LARGE_HANDLER_COUNT; i++) {
    const lines = [`import { validateToken } from "../auth.js";`, ""];
    for (let k = 0; k < 12; k++) {
      lines.push(`export function handler${i}_${k}(input: string): string { return input + "${i}-${k}"; }`);
    }
    lines.push(
      "",
      `export function guard${i}(payload: { sub: string; exp: number }, now: number): boolean {`,
      `  return validateToken(payload, now).ok;`,
      "}",
      "",
    );
    writeFile(dir, `src/handlers/h${i}.ts`, lines.join("\n"));
  }
  return { dir };
}

/**
 * The report's real-extension condition for TL142-03/05: copies, verbatim
 * at fixture-build time, the exact files this wave's brief names — see this
 * module's own doc comment for the mcpProvider.ts size caveat (11,456 B on
 * `develop` HEAD vs. the v0.14.2 VSIX's 8,276 B). `README.md` is written as
 * lowercase `readme.md`, matching the real VSIX's own filename casing.
 */
export function buildRealExtensionWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-ext");
  const srcDir = path.join(REPO_ROOT, "packages/vscode-extension");

  writeFile(dir, "src/mcpProvider.ts", fs.readFileSync(path.join(srcDir, "src/mcpProvider.ts"), "utf8"));
  writeFile(dir, "src/generated/schemaStamp.ts", fs.readFileSync(path.join(srcDir, "src/generated/schemaStamp.ts"), "utf8"));
  writeFile(dir, "src/diagnosticsPanel.ts", fs.readFileSync(path.join(srcDir, "src/diagnosticsPanel.ts"), "utf8"));
  writeFile(dir, "src/sidebar.ts", fs.readFileSync(path.join(srcDir, "src/sidebar.ts"), "utf8"));
  writeFile(dir, "src/extension.ts", fs.readFileSync(path.join(srcDir, "src/extension.ts"), "utf8"));
  writeFile(dir, "src/commands.ts", fs.readFileSync(path.join(srcDir, "src/commands.ts"), "utf8"));
  writeFile(dir, "package.json", fs.readFileSync(path.join(srcDir, "package.json"), "utf8"));
  writeFile(dir, "readme.md", fs.readFileSync(path.join(srcDir, "README.md"), "utf8"));

  return { dir };
}

/**
 * TL142-03 (2026-09-13, F3 fix wave): the VSIX-era condition — byte-exact
 * `git show 2103d622:packages/vscode-extension/<path>` copies (2103d622 =
 * the v0.14.2 release commit), vendored as static `./fixtures-0142-vsix/
 * *.txt` snapshots (never re-fetched from git at test time — history can be
 * rewritten/GC'd, and a `.txt` extension keeps tsc from ever parsing these
 * as TypeScript sources of THIS package). `buildRealExtensionWorkspace()`
 * above copies CURRENT develop HEAD's `src/mcpProvider.ts` (11,456 B); W0-A's
 * ledger and W0-B2's chip 3 both independently found that TL142-03 does NOT
 * reproduce against that larger file — every qref/task.handle re-pack dedups
 * cleanly. The v0.14.2 VSIX's OWN copy was only 8,276 B
 * (`scratchpad/arch-map-2.md` verified every one of these 8 files' sizes
 * against the addendum: mcpProvider.ts 8,276 B, schemaStamp.ts 731 B,
 * diagnosticsPanel.ts 13,477 B, sidebar.ts 32,137 B, extension.ts 1,894 B,
 * commands.ts 25,431 B, package.json 4,613 B, README.md 5,610 B — this
 * builder's own snapshots match every one of those exactly), and IS the
 * fixture that reproduces (see `scratchpad/wave0-repro-ledger.md`'s companion
 * agent's direct repro against this exact file set). Same filenames/casing
 * as `buildRealExtensionWorkspace()` (including lowercase `readme.md`), so a
 * spec can swap builders without touching any path string.
 */
export function buildVsixEraExtensionWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-ext-vsix");
  const snapshotDir = path.join(HERE, "fixtures-0142-vsix");
  const read = (name: string): string => fs.readFileSync(path.join(snapshotDir, `${name}.txt`), "utf8");

  writeFile(dir, "src/mcpProvider.ts", read("mcpProvider.ts"));
  writeFile(dir, "src/generated/schemaStamp.ts", read("schemaStamp.ts"));
  writeFile(dir, "src/diagnosticsPanel.ts", read("diagnosticsPanel.ts"));
  writeFile(dir, "src/sidebar.ts", read("sidebar.ts"));
  writeFile(dir, "src/extension.ts", read("extension.ts"));
  writeFile(dir, "src/commands.ts", read("commands.ts"));
  writeFile(dir, "package.json", read("package.json"));
  writeFile(dir, "readme.md", read("readme.md"));

  return { dir };
}

/**
 * BLOCKER 61 (AC1, 2026-09-14, review round 12) — THE WRITE-AUTHORITY LEAK
 * WORKSPACE, reconstructed byte-for-byte from the reviewer's own
 * `scratchpad/rv11ws-leak-*` fixture.
 *
 * Four ordinary files NO query in the spec names, each holding ONE identifier
 * that shares a token with a mutation VERB. Round 11 measured `Explain how
 * MAX_RETRIES works in src/retry.ts, and then set it to 5.` marking
 * `src/http.ts` writable (`why:"symbol hit for unknown"`) and a same-lane
 * `edit_file` REWRITING IT ON DISK; in the `remove` register `src/gc.ts` was the
 * ONLY writable entry, so an agent following the frontier literally edited the
 * wrong file.
 */
export function buildWriteAuthorityLeakWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-write-authority-leak");
  writeFile(dir, "package.json", MINIMAL_PACKAGE_JSON);
  writeFile(dir, "tsconfig.json", MINIMAL_TSCONFIG_JSON);
  writeFile(dir, "src/retry.ts", RETRY_TS);
  writeFile(dir, "src/http.ts", "export const SET_COOKIE = 'Set-Cookie';\n");
  writeFile(dir, "src/audit.ts", "export const UPDATE_MODE = 'append';\n");
  writeFile(dir, "src/gc.ts", "export const REMOVE_AFTER_MS = 1000;\nexport function removeExpired() {}\n");
  writeFile(dir, "src/ttl.ts", "export const CHANGE_WINDOW_MS = 50;\n");
  writeFile(dir, "src/bumper.ts", "export const BUMP_STEP = 1;\n");
  writeFile(dir, "notes.txt", "notes\n");
  writeFile(dir, "CHANGELOG.md", "# Changelog\n");
  return { dir };
}

/**
 * BLOCKER 62 (AC1, 2026-09-14, review round 12) — A NUL-STRIPPED EDIT TARGET.
 *
 * `src/retry.ts` carries `MAX_RETRIES = 3` and exactly ONE incidental NUL,
 * padded well past `MIN_NUL_FREE_RATIO` (0.99), so `readServedText` returns
 * `"stripped"`: the file IS served (NUL-free, with the strip stated) while
 * `detectWriteEncodingRisk` refuses to write it — any NUL in the first 4096
 * bytes. Round 11 measured `In src/retry.ts, set MAX_RETRIES to 5.` certifying
 * `act.edit` with that file writable and the only sanctioned `edit_file`
 * transition refusing with `retry:"call"`, which no `edits[]` shape can satisfy.
 *
 * The padding is a comment line, so the file stays a parseable TS module and the
 * locator reaches `MAX_RETRIES` exactly as it does in `buildEvalWorkspace`.
 */
export function buildStrippedEditTargetWorkspace(): { dir: string } {
  const dir = freshWorkspace("0142-stripped-edit-target");
  writeFile(dir, "package.json", MINIMAL_PACKAGE_JSON);
  writeFile(dir, "tsconfig.json", MINIMAL_TSCONFIG_JSON);
  writeFile(dir, "src/cache.ts", CACHE_TS);
  const abs = path.join(dir, "src/retry.ts");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // NEVER a literal NUL in this source file: String.fromCharCode(0), the same
  // spelling every other fixture in this module uses.
  const body = RETRY_TS + "// pad " + "x".repeat(600) + String.fromCharCode(0) + "\n";
  fs.writeFileSync(abs, Buffer.from(body, "utf8"));
  return { dir };
}
