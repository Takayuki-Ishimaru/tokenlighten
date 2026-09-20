/**
 * shortTmpDir.ts — a short, shallow workspace root for byte-budget-sensitive
 * specs on win32 (WFIX-Q group 10: docSliverByteCap / fullModeBudget /
 * fxoServeCoordinateSettlement / readCodePack all overshot their declared
 * wire-byte ceilings by a few dozen bytes on a real Windows run, never on
 * macOS/Linux).
 *
 * MEASURED ROOT CAUSE. It is not raw path LENGTH — a live Windows box's
 * `os.homedir()` (`C:\Users\ishim`, 14 chars) is shorter than this repo's
 * macOS CI `os.homedir()` (`/Users/takayuki`, 15 chars), and even
 * `os.tmpdir()` (`C:\Users\ishim\AppData\Local\Temp`, 33 chars) is shorter
 * than macOS's realpath'd `os.tmpdir()` (`/private/var/folders/<id>/T`, 56
 * chars on the machine this fix was measured on) — by raw character count
 * Windows should ship FEWER bytes, not more. `core.autocrlf` is `false`
 * both globally and in this repo's local config on the verified box, and a
 * direct byte-for-byte check of the checked-out spec/fixture files found
 * zero CRLF — so it is not a checkout line-ending inflation either.
 *
 * It is JSON escaping of the path SEPARATOR. A served payload embeds the
 * absolute workspace path (`next.arguments.cwd`, `evidence[].path`-derived
 * handles, etc.), sometimes more than once. On POSIX, `/` is valid unescaped
 * inside a JSON string. On win32, every `\` must be escaped to `\\` — one
 * extra wire byte per path SEGMENT, per occurrence, that POSIX never pays,
 * regardless of how long or short the segment names themselves are. A
 * `os.tmpdir()`-rooted workspace (`C:\Users\<user>\AppData\Local\Temp\...`)
 * carries 6+ segments; even the shallower `os.homedir()`-rooted one
 * (`C:\Users\<user>\...`) carries 3. `C:\t\<random>` carries 2 — the fewest
 * an absolute Windows path can have — which is why the fix is a shallow
 * root, not merely a shorter one.
 *
 * ALLOWED-PARENTS. An in-process `callTool({cwd})` call (as opposed to a
 * spawned server started WITH that directory as its own root argument)
 * validates `cwd` against `TOKENLIGHTEN_ALLOWED_PARENTS` — root's/each
 * package's `vitest.config.ts` grants `os.homedir()` by default, which is
 * why every existing caller here was already rooted at `os.homedir()` or
 * pierced through it (see `explorationContinuationFixtures.ts`'s header for
 * the same constraint on `os.tmpdir()`). Moving to `C:\t` on win32 needs the
 * same kind of grant, so this module extends
 * `process.env.TOKENLIGHTEN_ALLOWED_PARENTS` (additively, once) instead of
 * replacing it — a spawned server's inherited `env: {...process.env}`
 * (readCodePack.spec.ts, fxoServeCoordinateSettlement.spec.ts) picks this up
 * automatically too.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const WIN32_SHORT_ROOT = "C:\\t";

let win32RootPrepared = false;

function win32ShortRoot(): string {
  if (!win32RootPrepared) {
    fs.mkdirSync(WIN32_SHORT_ROOT, { recursive: true });
    const existing = (process.env["TOKENLIGHTEN_ALLOWED_PARENTS"] ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    if (!existing.includes(WIN32_SHORT_ROOT)) {
      existing.push(WIN32_SHORT_ROOT);
      process.env["TOKENLIGHTEN_ALLOWED_PARENTS"] = existing.join(path.delimiter);
    }
    win32RootPrepared = true;
  }
  return WIN32_SHORT_ROOT;
}

/**
 * `fs.mkdtempSync`'s prefix, rooted at `posixBase` unchanged on POSIX (every
 * existing call site keeps its own base — `os.tmpdir()`, `os.homedir()`,
 * whatever it already was — so POSIX behaviour is byte-identical) or at the
 * shallow `C:\t` on win32, where the caller's descriptive `prefix` is
 * dropped in favour of a bare random suffix (the leaf name's own characters
 * count the same way the separators do). Does NOT realpath the result —
 * callers that previously wrapped the old `fs.mkdtempSync(...)` call in
 * `fs.realpathSync(...)` keep doing so around this one; callers that did not
 * still do not.
 */
export function shortTmpDir(posixBase: string, prefix: string): string {
  if (process.platform !== "win32") {
    return fs.mkdtempSync(path.join(posixBase, prefix));
  }
  return fs.mkdtempSync(win32ShortRoot() + path.sep);
}
