/**
 * TOML config read / write for TokenLighten CLI.
 *
 * Atomic write via tmp-file rename (docs/components/06-platform-support.md §10.3).
 * Uses smol-toml for parsing and serialization.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { parse, stringify } from "smol-toml";
import { makeTmpPath, retryRename } from "./atomicWrite.js";

export type TomlValue =
  | string
  | number
  | boolean
  | Date
  | TomlValue[]
  | { [key: string]: TomlValue };

type TomlDocument = Record<string, TomlValue>;

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__"]);

function hasUnsafePathSegment(parts: readonly string[]): boolean {
  return parts.some((part) => UNSAFE_PATH_SEGMENTS.has(part));
}

/**
 * Read and parse a TOML config file.
 * Returns an empty object if the file does not exist.
 */
export function readConfig(filePath: string): TomlDocument {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, "utf-8");
  return parse(raw) as TomlDocument;
}

/**
 * Write a TOML document to a file atomically (tmp → rename).
 * Creates parent directories if needed.
 */
export function writeConfig(filePath: string, doc: TomlDocument): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const serialized = stringify(doc as Record<string, unknown>);
  // tmp lives in same directory as target — avoids EXDEV on Linux tmpfs mounts
  const tmpPath = makeTmpPath(filePath);

  writeFileSync(tmpPath, serialized, { encoding: "utf-8", mode: 0o600 });
  // Atomic rename with EBUSY retry (Windows file-lock); EROFS bubbles immediately.
  retryRename(tmpPath, filePath);
}

/**
 * Get a nested value from the config document using a dot-path key.
 * Example: getNestedKey(doc, "mcp.workspaceRoot")
 * Returns undefined if any segment is missing.
 */
export function getNestedKey(
  doc: TomlDocument,
  dotPath: string
): TomlValue | undefined {
  const parts = dotPath.split(".");
  if (hasUnsafePathSegment(parts)) return undefined;
  let current: TomlValue = doc;

  for (const part of parts) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as TomlDocument)[part] as TomlValue;
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/**
 * Set a nested value in the config document using a dot-path key.
 * Creates intermediate tables as needed.
 * Mutates the document in place and returns the same reference.
 */
export function setNestedKey(
  doc: TomlDocument,
  dotPath: string,
  value: TomlValue
): TomlDocument {
  const parts = dotPath.split(".");
  if (hasUnsafePathSegment(parts)) {
    throw new Error("config key contains a reserved path segment");
  }
  let current: TomlDocument = doc;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (
      current[part] === undefined ||
      typeof current[part] !== "object" ||
      Array.isArray(current[part])
    ) {
      current[part] = {};
    }
    current = current[part] as TomlDocument;
  }

  const lastKey = parts[parts.length - 1]!;
  current[lastKey] = value;
  return doc;
}

/**
 * Parse a string value into an appropriate TOML primitive.
 * Tries number, boolean, then falls back to string.
 */
export function parseValue(raw: string): TomlValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== "") return num;
  return raw;
}
