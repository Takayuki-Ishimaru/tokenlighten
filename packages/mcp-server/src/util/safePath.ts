/**
 * safePath.ts — workspace-scoped path resolution and safe file reads.
 *
 * Extracted from server.ts so intents and tool modules can guard against
 * path-traversal and symlink-escape without importing server internals.
 *
 * All functions require an explicit `root` argument — no process-global default.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { realpathSync, statSync, type Stats } from "fs";
import { trace } from "./trace.js";
import type { GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

export function resolveReal(p: string): string {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

export function isWithin(child: string, base: string): boolean {
  return child === base || child.startsWith(base + path.sep);
}

export function safeResolve(rel: string, root: string): string | undefined {
  const abs = path.resolve(root, rel);
  return isWithin(abs, path.resolve(root)) ? abs : undefined;
}

/**
 * `safeResolve` for a path that is about to be WRITTEN.
 *
 * Identical containment arithmetic — it delegates, so the two can never
 * diverge — but it will only accept a root that carries the dispatch guard's
 * brand (write/guardedWorkspace.ts). Resolving a write target against a root
 * nobody guarded is the exact shape of the 2026-08-09 incident, and the type
 * error is the point: an unguarded root has no way to reach this function.
 */
export function safeResolveForWrite(
  rel: string,
  root: GuardedWorkspaceRoot,
): string | undefined {
  return safeResolve(rel, root);
}

export async function safeRealPath(abs: string, rootReal: string): Promise<string | undefined> {
  try {
    const real = await fs.realpath(abs);
    return isWithin(real, rootReal) ? real : undefined;
  } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Shared read-path resource cap (CWE-400 / CWE-789)
// ---------------------------------------------------------------------------
//
// `readFileSafe`/`readBytesSafe` are the common read path — roughly 38 call
// sites across this package, ~32 of them dispatch branches in server.ts. They
// resolved containment correctly but then handed a caller-named path straight
// to `fs.readFile`, with no stat, no file-type check and no byte ceiling:
//
//   * a FIFO (or any other non-regular node) inside the workspace hangs the
//     server forever, because `open(2)` on a FIFO blocks until a writer shows
//     up and `fs.readFile` opens before it can tell you what it opened;
//   * an arbitrarily large regular file is fully resident before any consumer
//     gets to apply its own budget (mode=full's READ_FULL_CAP_BYTES trims a
//     buffer that is already in memory — the read itself is the OOM).
//
// `stat(2)` answers both questions WITHOUT opening the file, so a stat-first
// guard is safe on exactly the input that would otherwise block. Fixing it
// here covers every caller without touching one of them.
//
// The ceiling is deliberately generous — this is a resource-exhaustion
// backstop, not a policy budget. Consumers keep their own, much tighter,
// limits (5 MB edit/write, 1 MB walk, 512/256/128 KB scans). 64 MiB matches
// the largest bound already in the package (graph/index.ts's
// GRAPH_INDEX_MAX_BYTES) and sits comfortably above the largest legitimate
// read that flows through here today: an OOXML/PDF artifact container, capped
// at ZIP_LIMITS.maxCompressedBytes = 25 MB. Nothing that works today stops
// working.

/** Default ceiling for the shared read helpers. See the note above. */
export const READ_PATH_MAX_BYTES = 64 * 1024 * 1024;

/** Per-call override for the shared read helpers. */
export interface SafeReadOptions {
  /**
   * Byte ceiling for this call. Omitted, non-finite or negative values fall
   * back to READ_PATH_MAX_BYTES, so a malformed override can never widen the
   * cap to infinity.
   */
  maxBytes?: number;
}

/** Resolve the effective ceiling for a call, rejecting nonsense overrides. */
export function effectiveReadCap(options?: SafeReadOptions): number {
  const requested = options?.maxBytes;
  return typeof requested === "number" && Number.isFinite(requested) && requested >= 0
    ? requested
    : READ_PATH_MAX_BYTES;
}

/** Why a read target was refused before it was opened. */
export type ReadTargetRefusal = "stat-failed" | "not-a-regular-file" | "too-large";

export type ReadTargetVerdict =
  | { ok: true; sizeBytes: number; maxBytes: number }
  | { ok: false; reason: ReadTargetRefusal; sizeBytes: number; maxBytes: number };

function fileKindOf(st: {
  isDirectory(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
}): string {
  if (st.isDirectory()) return "directory";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isCharacterDevice()) return "character-device";
  if (st.isBlockDevice()) return "block-device";
  return "other";
}

/**
 * Stat an ALREADY-REALPATH'D target and decide whether it may be read.
 *
 * `real` must have come from `safeRealPath`/`realpathSync` — containment is
 * this function's caller's job, and stat-ing a not-yet-resolved path would
 * reintroduce the symlink race this module exists to close.
 *
 * Refusals are traced (TL_TRACE=1) with path, size and cap so an over-cap
 * refusal is distinguishable from a missing file in the log; both otherwise
 * degrade to the same `null` the helpers have always returned.
 */
export async function checkReadTarget(
  real: string,
  root: string,
  options?: SafeReadOptions,
): Promise<ReadTargetVerdict> {
  const maxBytes = effectiveReadCap(options);
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    // stat(2), unlike open(2), never blocks on a FIFO with no writer.
    st = await fs.stat(real);
  } catch {
    trace("read-path-refused", { path: real, reason: "stat-failed", maxBytes }, root);
    return { ok: false, reason: "stat-failed", sizeBytes: 0, maxBytes };
  }
  if (!st.isFile()) {
    trace(
      "read-path-refused",
      { path: real, reason: "not-a-regular-file", kind: fileKindOf(st), sizeBytes: st.size, maxBytes },
      root,
    );
    return { ok: false, reason: "not-a-regular-file", sizeBytes: st.size, maxBytes };
  }
  if (st.size > maxBytes) {
    trace(
      "read-path-refused",
      { path: real, reason: "too-large", sizeBytes: st.size, maxBytes },
      root,
    );
    return { ok: false, reason: "too-large", sizeBytes: st.size, maxBytes };
  }
  return { ok: true, sizeBytes: st.size, maxBytes };
}

/**
 * Synchronous sibling of `checkReadTarget`, for the sync read sites that
 * already needed the `Stats` anyway (the edit intents read `.mode` off it to
 * preserve file permissions). Returns the Stats on success; THROWS on refusal,
 * so a call site can drop it into the `try` block that already wraps its
 * `readFileSync` and keep its existing failure shape untouched — a directory
 * target already threw EISDIR from that read, this just moves the throw a line
 * earlier and adds the two cases the read could not survive at all.
 */
export function statReadTargetSync(
  real: string,
  root: string,
  options?: SafeReadOptions,
): Stats {
  const maxBytes = effectiveReadCap(options);
  const st = statSync(real);
  if (!st.isFile()) {
    trace(
      "read-path-refused",
      { path: real, reason: "not-a-regular-file", kind: fileKindOf(st), sizeBytes: st.size, maxBytes },
      root,
    );
    throw new Error(`not a regular file: ${real}`);
  }
  if (st.size > maxBytes) {
    trace("read-path-refused", { path: real, reason: "too-large", sizeBytes: st.size, maxBytes }, root);
    throw new Error(`file too large to read: ${real} (${st.size} bytes > ${maxBytes})`);
  }
  return st;
}

/**
 * Belt-and-braces: the file can grow between the stat and the read, so the
 * resident buffer gets the same ceiling the stat did.
 */
function refuseIfGrown(
  byteLength: number,
  real: string,
  root: string,
  maxBytes: number,
): boolean {
  if (byteLength <= maxBytes) return false;
  trace(
    "read-path-refused",
    { path: real, reason: "too-large", sizeBytes: byteLength, maxBytes, raced: true },
    root,
  );
  return true;
}

export async function readFileSafe(
  rel: string,
  root: string,
  options?: SafeReadOptions,
): Promise<string | null> {
  const abs = safeResolve(rel, root);
  if (!abs) return null;
  const real = await safeRealPath(abs, resolveReal(root));
  if (!real) return null;
  const verdict = await checkReadTarget(real, root, options);
  if (!verdict.ok) return null;
  try {
    // Read as bytes and size-check BEFORE decoding: a raced over-cap file is
    // refused without ever allocating the string. (`fs.readFile(p, "utf8")`
    // materializes the same buffer internally, so this is not an extra copy.)
    const buf = await fs.readFile(real);
    if (refuseIfGrown(buf.byteLength, real, root, verdict.maxBytes)) return null;
    return buf.toString("utf8");
  } catch { return null; }
}

export async function readBytesSafe(
  rel: string,
  root: string,
  options?: SafeReadOptions,
): Promise<Uint8Array | null> {
  const abs = safeResolve(rel, root);
  if (!abs) return null;
  const real = await safeRealPath(abs, resolveReal(root));
  if (!real) return null;
  const verdict = await checkReadTarget(real, root, options);
  if (!verdict.ok) return null;
  try {
    const buf = await fs.readFile(real);
    if (refuseIfGrown(buf.byteLength, real, root, verdict.maxBytes)) return null;
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch { return null; }
}
