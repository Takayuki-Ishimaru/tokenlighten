/**
 * requestFileCache.ts — the bytes of a file read once per MCP request.
 *
 * One tool call reads the same files many times: the locator, the literal
 * scans, the reference scan and the served-text decoder each open every file
 * they consider (2026-10-30, shopflow T03 first call: 10,227 reads of 643
 * files, `OrderOrchestrator.java` 265 times). On Windows every open of file
 * data is scanned by the real-time antivirus, so those opens were most of the
 * call's 30 s.
 *
 * `readFileForRequest` stats the file on every call and returns the bytes read
 * earlier in the SAME request only while the file's identity — device, inode,
 * size, mtime and ctime — is unchanged; a write in between (an edit, another
 * process) changes it and the file is read again. A same-size rewrite inside
 * one clock tick of the previous write keeps the identity and is not seen until
 * the next request. It returns a copy, so a caller that mutates its buffer
 * never changes what the next caller gets.
 * The request is the one `requestCancellation.ts` binds (its signal is the
 * key); outside a bound request (the CLI, unit tests that call a tool
 * directly) every call is a plain `readFileSync`.
 */
import * as fs from "node:fs";
import { currentRequestSignal } from "./requestCancellation.js";

interface HeldFile {
  identity: string;
  bytes: Buffer;
}

interface RequestFiles {
  files: Map<string, HeldFile>;
  bytes: number;
}

const byRequest = new WeakMap<AbortSignal, RequestFiles>();

/** File bytes one request keeps; a file that does not fit is read through. */
export const REQUEST_FILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** `fs.readFileSync(absPath)`, reusing bytes this request already read from the unchanged file. */
export function readFileForRequest(absPath: string): Buffer {
  const signal = currentRequestSignal();
  if (signal === undefined) return fs.readFileSync(absPath);
  const stat = fs.statSync(absPath, { bigint: true });
  if (!stat.isFile()) return fs.readFileSync(absPath);
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  let held = byRequest.get(signal);
  if (held === undefined) {
    held = { files: new Map(), bytes: 0 };
    byRequest.set(signal, held);
  }
  const hit = held.files.get(absPath);
  if (hit !== undefined && hit.identity === identity) return Buffer.from(hit.bytes);
  const bytes = fs.readFileSync(absPath);
  if (hit !== undefined) {
    held.files.delete(absPath);
    held.bytes -= hit.bytes.length;
  }
  if (held.bytes + bytes.length <= REQUEST_FILE_CACHE_MAX_BYTES) {
    held.files.set(absPath, { identity, bytes: Buffer.from(bytes) });
    held.bytes += bytes.length;
  }
  return bytes;
}
