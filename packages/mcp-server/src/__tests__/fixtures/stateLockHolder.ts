/**
 * stateLockHolder.ts — test fixture, spawned via tsx by
 * stateStoreConcurrency.spec.ts (never imported directly): acquires
 * state/writerLock.ts's writer lock on a given directory and either holds it
 * forever (until killed — the "kill -9 the holder" and "fresh lock is never
 * stolen" drills need a DETERMINISTIC hold, not a statistical chance of
 * catching a real server mid-operation) or for a bounded duration and then
 * releases cleanly.
 *
 * argv: <dir> <mode>
 *   dir  = the STORE directory (i.e. `<workspaceRoot>/.tokenlighten/state`,
 *          computed by the caller — this fixture does not know about
 *          workspace roots, only the literal lock directory)
 *   mode = "forever"      hold until killed; never release
 *   mode = "forever-torn" like "forever", but first appends a deliberately
 *                         INCOMPLETE journal.ndjson line (valid JSON prefix,
 *                         no closing brace, no trailing newline) — what a
 *                         real writer's appendFileSync would leave behind if
 *                         killed mid-syscall
 *   mode = "ms:<N>"       hold for N ms, release cleanly, exit 0
 *
 * Prints exactly one synchronization line to stdout: "READY <pid>\n" once
 * the lock is held, or "FAILED\n" if acquisition itself failed — the parent
 * waits for one of these rather than polling.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { acquireWriterLock } from "../../state/writerLock.js";

const [, , dir, mode] = process.argv;
if (dir === undefined || mode === undefined) {
  process.stderr.write("usage: stateLockHolder.ts <dir> <forever|forever-torn|ms:N>\n");
  process.exit(2);
}

mkdirSync(dir, { recursive: true, mode: 0o700 });

const lock = acquireWriterLock(dir);
if (lock === undefined) {
  process.stdout.write("FAILED\n");
  process.exit(1);
}

if (mode === "forever-torn") {
  appendFileSync(join(dir, "journal.ndjson"), '{"t":"put","r":{"key":"torn-mid-writ');
}

process.stdout.write(`READY ${process.pid}\n`);

if (mode === "forever" || mode === "forever-torn") {
  // Stay alive without busy-spinning until the parent sends SIGKILL. Never
  // release — that IS the scenario under test (a crash leaves the lock
  // behind).
  setInterval(() => {}, 60_000);
} else if (mode.startsWith("ms:")) {
  const ms = Number(mode.slice(3));
  setTimeout(
    () => {
      lock.release();
      process.stdout.write("RELEASED\n");
      process.exit(0);
    },
    Number.isFinite(ms) ? ms : 0,
  );
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  lock.release();
  process.exit(2);
}
