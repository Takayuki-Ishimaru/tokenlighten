/**
 * handleKeys.ts — installation-local key material for PI-09 explicit state
 * handles (v0.10 alpha.2).
 *
 * WHAT THIS OWNS. One HMAC-SHA256 secret per installation, plus the stable
 * `installationId` that `DecodedStateHandle.subjectRef` is derived from. Both
 * live in ONE user-only file under the platform config directory, mirroring
 * `packages/cli/src/paths.ts`'s `config` bucket (the same directory
 * `tl doctor`'s `config_dir_write` probe writes to) — mcp-server cannot import
 * the CLI (dependency direction), so the bucket rules are re-expressed here and
 * the env-override precedence is kept byte-compatible with that module:
 *
 *   1. `TOKENLIGHTEN_STATE_KEY_DIR`   — dedicated override (tests, sandboxes)
 *   2. `TOKENLIGHTEN_CONFIG_HOME`     — per-bucket override (CLI-compatible)
 *   3. `TOKENLIGHTEN_HOME`/config     — umbrella override (CLI-compatible)
 *   4. platform default               — Application Support / XDG / APPDATA
 *
 * SECURITY POSTURE (plan invariant, PI-09 item 7 "local storeはuser-only
 * permission"):
 *
 *  - directory created 0700, file created 0600, and BOTH re-chmod'd when a
 *    pre-existing object is looser than that (the `ensurePrivateRuntimeDir`
 *    discipline from the CLI's paths.ts, applied to the key file itself).
 *  - a symlink where the key file should be is a REFUSAL to use the file at
 *    all, never a follow — the process falls back to an ephemeral key.
 *  - the secret NEVER leaves this module as bytes anyone else keeps: callers
 *    get an opaque `HandleKeyRing` and ask it to sign/verify.
 *
 * DEGRADATION IS HONEST, NOT SILENT. If the key file cannot be created or read
 * (read-only FS, hostile perms, corrupt JSON), the ring falls back to a
 * process-EPHEMERAL key and reports `persistent: false`. Handles minted under
 * an ephemeral key still work for the life of the process and then fail
 * validation as `invalid` after a restart — i.e. the fail-closed refusal path,
 * which is exactly what PI-09's acceptance criterion asks for ("失われたstateは
 * 100%明示的stale refusal＋recovery"). A corrupt key file is PRESERVED to a
 * `.corrupt-<ts>` sidecar rather than deleted, so an operator can recover it.
 *
 * KEY ROTATION (PI-09 item 15). The file holds a KEY SET, not one key: mint
 * always uses `activeKeyId`, validation looks the token's `keyId` up in the
 * whole set. Adding a new active key while retaining the old one therefore
 * rotates without invalidating outstanding handles; dropping a key from the
 * set revokes every handle it signed. v0.10 ships the mechanism and one key —
 * an explicit rotation COMMAND is release-operations work, not wire work.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_NAME = "tokenlighten";
const KEY_FILE = "state-handle-keys.json";

/** Bytes of HMAC key material. 32 = the SHA-256 block-optimal secret size. */
const SECRET_BYTES = 32;

/** Bytes of key id. 4 -> 8 hex chars in `DecodedStateHandle.keyId`. */
const KEY_ID_BYTES = 4;

/** Bytes of installation identity. Hashed again before it reaches a token. */
const INSTALLATION_ID_BYTES = 16;

export interface HandleKeyRecord {
  keyId: string;
  /** base64 of the raw HMAC secret. Never leaves this module. */
  secret: string;
  createdAtMs: number;
}

interface KeyFileShape {
  v: 1;
  installationId: string;
  activeKeyId: string;
  keys: HandleKeyRecord[];
}

export interface HandleKeyRing {
  /** Key id used for every NEW mint. */
  readonly activeKeyId: string;
  /** Stable installation identity; `subjectRef` is a hash of this. */
  readonly installationId: string;
  /** False when the ring is process-ephemeral (no durable key file). */
  readonly persistent: boolean;
  /** Absolute path of the key file, or undefined when ephemeral. */
  readonly path?: string;
  /** HMAC-SHA256 over `message` with the ACTIVE key, truncated to `bytes`. */
  sign(message: Buffer, bytes: number): Buffer;
  /**
   * Constant-time verification against the key named by `keyId`.
   * Returns false for an unknown key id — never throws.
   */
  verify(keyId: string, message: Buffer, mac: Buffer): boolean;
}

// ---------------------------------------------------------------------------
// Config-directory resolution (CLI paths.ts `config` bucket, re-expressed)
// ---------------------------------------------------------------------------

function platformConfigDir(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    const appdata = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    return join(appdata, APP_NAME, "Config");
  }
  const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  return join(xdgConfig, APP_NAME);
}

/** The directory the key file lives in, honouring the documented precedence. */
export function stateKeyDir(): string {
  const dedicated = process.env["TOKENLIGHTEN_STATE_KEY_DIR"];
  if (dedicated !== undefined && dedicated !== "") return dedicated;
  const perBucket = process.env["TOKENLIGHTEN_CONFIG_HOME"];
  if (perBucket !== undefined && perBucket !== "") return perBucket;
  const umbrella = process.env["TOKENLIGHTEN_HOME"];
  if (umbrella !== undefined && umbrella !== "") return join(umbrella, "config");
  return platformConfigDir();
}

// ---------------------------------------------------------------------------
// Private-mode helpers
// ---------------------------------------------------------------------------

/** mkdir 0700 and tighten a pre-existing directory that is looser. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`state key directory is not a real directory: ${dir}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

/**
 * Read the key file, refusing to follow a symlink and tightening a file whose
 * mode leaked group/world bits. Returns undefined when there is nothing usable.
 */
function readKeyFile(file: string): KeyFileShape | undefined {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`state key file is not a regular file: ${file}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    // A key that was ever world-readable is not trusted to stay secret, but
    // deleting it would silently revoke every outstanding handle. Tighten it
    // and keep using it; an operator-visible perms fix, not a data loss.
    chmodSync(file, 0o600);
  }
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isKeyFileShape(parsed)) throw new Error("state key file has an unknown shape");
  return parsed;
}

function isKeyFileShape(value: unknown): value is KeyFileShape {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["v"] !== 1) return false;
  if (typeof v["installationId"] !== "string" || v["installationId"] === "") return false;
  if (typeof v["activeKeyId"] !== "string" || v["activeKeyId"] === "") return false;
  if (!Array.isArray(v["keys"]) || v["keys"].length === 0) return false;
  for (const key of v["keys"] as unknown[]) {
    if (typeof key !== "object" || key === null) return false;
    const k = key as Record<string, unknown>;
    if (typeof k["keyId"] !== "string" || k["keyId"] === "") return false;
    if (typeof k["secret"] !== "string" || k["secret"] === "") return false;
  }
  return (v["keys"] as HandleKeyRecord[]).some((k) => k.keyId === v["activeKeyId"]);
}

/** Preserve an unusable key file instead of destroying it. */
function preserveCorrupt(file: string): void {
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* best effort: an unmovable file is left where it is and bypassed */
  }
}

/** Write the key file 0600, creating it exclusively so a race cannot clobber. */
function writeKeyFile(file: string, shape: KeyFileShape): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(shape), { encoding: "utf8" });
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

// ---------------------------------------------------------------------------
// Ring construction
// ---------------------------------------------------------------------------

function ringFrom(shape: KeyFileShape, path: string | undefined): HandleKeyRing {
  const secrets = new Map<string, Buffer>();
  for (const record of shape.keys) {
    secrets.set(record.keyId, Buffer.from(record.secret, "base64"));
  }
  const active = secrets.get(shape.activeKeyId)!;
  return {
    activeKeyId: shape.activeKeyId,
    installationId: shape.installationId,
    persistent: path !== undefined,
    ...(path !== undefined ? { path } : {}),
    sign(message: Buffer, bytes: number): Buffer {
      return createHmac("sha256", active).update(message).digest().subarray(0, bytes);
    },
    verify(keyId: string, message: Buffer, mac: Buffer): boolean {
      const secret = secrets.get(keyId);
      if (secret === undefined) return false;
      const expected = createHmac("sha256", secret).update(message).digest().subarray(0, mac.length);
      if (expected.length !== mac.length) return false;
      return timingSafeEqual(expected, mac);
    },
  };
}

function freshShape(): KeyFileShape {
  const keyId = randomBytes(KEY_ID_BYTES).toString("hex");
  return {
    v: 1,
    installationId: randomBytes(INSTALLATION_ID_BYTES).toString("hex"),
    activeKeyId: keyId,
    keys: [{ keyId, secret: randomBytes(SECRET_BYTES).toString("base64"), createdAtMs: Date.now() }],
  };
}

let _ring: HandleKeyRing | undefined;

/**
 * The process-wide key ring, created on first use.
 *
 * NEVER THROWS. Every failure mode (unwritable dir, symlinked key file, corrupt
 * JSON, exclusive-create race) degrades to a process-ephemeral ring, which the
 * caller can detect through `persistent`.
 */
export function handleKeyRing(): HandleKeyRing {
  if (_ring !== undefined) return _ring;
  const dir = stateKeyDir();
  const file = join(dir, KEY_FILE);
  try {
    ensurePrivateDir(dir);
    let shape: KeyFileShape | undefined;
    try {
      shape = readKeyFile(file);
    } catch {
      preserveCorrupt(file);
      shape = undefined;
    }
    if (shape === undefined) {
      const created = freshShape();
      try {
        writeKeyFile(file, created);
        shape = created;
      } catch {
        // Lost an exclusive-create race, or the FS refused: re-read once so two
        // servers starting together converge on ONE key rather than forking.
        shape = readKeyFile(file);
        if (shape === undefined) throw new Error("key file unavailable");
      }
    }
    _ring = ringFrom(shape, file);
  } catch {
    _ring = ringFrom(freshShape(), undefined);
  }
  return _ring;
}

/** Test hook: drop the memoized ring so the next call re-reads the file. */
export function resetHandleKeyRingForTests(): void {
  _ring = undefined;
}
