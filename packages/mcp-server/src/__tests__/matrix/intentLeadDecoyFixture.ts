/**
 * intentLeadDecoyFixture.ts — the wire-layer workspace for
 * `intentLeadMatrix.spec.ts` (MX-A, 2026-09-14, `scratchpad/brief-matrix.md`).
 *
 * ONE combined workspace: `buildEvalWorkspace()` (reused verbatim, per the
 * brief — `src/auth.ts`/`src/retry.ts`/`src/cache.ts`/`src/index.ts`, the
 * `intentLeadGenerator.ts` PRIMARY/SECONDARY targets) layered with the SAME
 * decoy files `buildWriteAuthorityLeakWorkspace()` (AC1's own BLOCKER-61
 * regression-pin fixture, `helpers/handsOnReport0142Fixtures.ts`) uses —
 * `src/http.ts`/`src/audit.ts`/`src/gc.ts`/`src/ttl.ts`/`src/bumper.ts`, each
 * holding one identifier that shares a token with an edit VERB, none ever
 * named by any generated query — so a leak this matrix's own generator
 * reproduces lands on the SAME reviewer-verified decoy shape
 * (`review-findings-11.md` BLOCKER 61, `rv11-leak.log`/`rv11-note77.log`),
 * not a new one this file invents. `notes.txt` is BLOCKER 34's own
 * round-6/7 quoted/bare-filename decoy (`review-findings-6.md`/`-7.md`).
 *
 * Deliberately ONE workspace shared by every describe in the spec (matching
 * `buildWriteAuthorityLeakWorkspace`'s own single-workspace-per-describe
 * convention) — `buildIntentLeadWorkspace()` is called once per `describe`
 * via `useCaseServer`, never per-cell, so hundreds of wire calls never pay
 * hundreds of mkdtemp costs.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { buildEvalWorkspace } from "../helpers/handsOnReport0142Fixtures.js";
import { CHANGELOG_PATH, NOTES_PATH, PRIMARY, SECONDARY } from "./intentLeadGenerator.js";

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/**
 * The combined workspace. `src/retry.ts`/`src/cache.ts` come from
 * `buildEvalWorkspace()` unchanged (byte-identical `MAX_RETRIES = 3`/
 * `DEFAULT_TTL_MS = 60000`, matching `intentLeadGenerator.ts`'s
 * PRIMARY/SECONDARY exactly, so a generated cell's `oldValue`/`newValue`
 * are the REAL on-disk values, not a guess). Decoy files match
 * `buildWriteAuthorityLeakWorkspace()` verbatim (see that function,
 * `helpers/handsOnReport0142Fixtures.ts`) plus `docs.md` for the
 * "docs"/「ドキュメント」 noun-phrase object shape, which no prior fixture needed.
 */
export function buildIntentLeadWorkspace(): { dir: string } {
  const { dir } = buildEvalWorkspace();

  // Sanity: PRIMARY/SECONDARY must describe files this workspace really has,
  // at the values the generator assumes — fail LOUDLY here rather than
  // leave every wire cell to fail with an unrelated-looking mismatch.
  const retry = fs.readFileSync(path.join(dir, PRIMARY.path), "utf8");
  if (!retry.includes(`${PRIMARY.identifier} = ${PRIMARY.oldValue}`)) {
    throw new Error(`intentLeadDecoyFixture: buildEvalWorkspace()'s ${PRIMARY.path} no longer reads "${PRIMARY.identifier} = ${PRIMARY.oldValue}" — update PRIMARY in intentLeadGenerator.ts`);
  }
  const cache = fs.readFileSync(path.join(dir, SECONDARY.path), "utf8");
  if (!cache.includes(`${SECONDARY.identifier} = ${SECONDARY.oldValue}`)) {
    throw new Error(`intentLeadDecoyFixture: buildEvalWorkspace()'s ${SECONDARY.path} no longer reads "${SECONDARY.identifier} = ${SECONDARY.oldValue}" — update SECONDARY in intentLeadGenerator.ts`);
  }

  // BLOCKER-61 decoys — byte-identical to buildWriteAuthorityLeakWorkspace().
  write(dir, "src/http.ts", "export const SET_COOKIE = 'Set-Cookie';\n");
  write(dir, "src/audit.ts", "export const UPDATE_MODE = 'append';\n");
  write(dir, "src/gc.ts", "export const REMOVE_AFTER_MS = 1000;\nexport function removeExpired() {}\n");
  write(dir, "src/ttl.ts", "export const CHANGE_WINDOW_MS = 50;\n");
  write(dir, "src/bumper.ts", "export const BUMP_STEP = 1;\n");

  // BLOCKER-34 decoys (round-6/7 quoted/bare-filename attacks) + noun-phrase targets.
  write(dir, NOTES_PATH, "notes\n");
  write(dir, CHANGELOG_PATH, "# Changelog\n");
  write(dir, "docs.md", "# Docs\n");

  return { dir };
}

/** Every decoy path this workspace adds beyond `buildEvalWorkspace()`'s own files — none is ever named by a generated query; a wire cell must never mark one writable. */
export const DECOY_PATHS: readonly string[] = ["src/http.ts", "src/audit.ts", "src/gc.ts", "src/ttl.ts", "src/bumper.ts"];
