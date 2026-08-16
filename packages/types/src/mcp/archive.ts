export type ArchiveFormat = "zip" | "tar" | "tar.gz" | "7z" | "rar";

/**
 * Canonical, unambiguous archive address. `path` is workspace-relative;
 * `member` and `prefix` use normalized POSIX separators inside the container.
 */
export interface ArchiveSelector {
  path: string;
  member?: string;
  prefix?: string;
}

export type ArchiveFailureCode =
  | "archive-not-found"
  | "archive-unsupported"
  | "archive-corrupt"
  | "archive-encrypted"
  | "archive-password-invalid"
  | "archive-encryption-unsupported"
  | "archive-too-large"
  | "archive-too-many-entries"
  | "archive-bomb"
  | "archive-unsafe-path"
  | "archive-entry-not-found"
  | "archive-entry-binary"
  | "archive-member-too-large"
  | "archive-member-read-only";

export interface ReadFileArchiveInput {
  mode: "archive";
  archive: ArchiveSelector;
  /** Opaque password reference resolved by the MCP server; never the password itself. */
  credentialRef?: string;
}

/**
 * protocol v1 (A.9.1, `archive.ts` row): this is the `read.artifact` `archive`
 * form's ELEMENT TYPE — `ArtifactContent.form: "archive"` carries
 * `entries: ReadFileArchiveEntry[]` (A.5.5). `kind` here is a NESTED
 * vocabulary and does not collide with the top-level discriminator (Rule K).
 *
 * PRE-PUBLISH OBLIGATION (A.5.5, A.9.2's collected list), DISCHARGED 2026-08-14
 * by C2-3's §3.4 E2 pass: `"binary"` was DECLARED AND UNREACHABLE. The sole
 * construction site is a two-arm ternary (`tools/archive.ts:676`,
 * `isLikelyTextMember(entry.member) ? "text" : "unknown"`) and a repo-wide
 * search found zero readers of the value — no comparison, no switch arm, no
 * test. Under §1.4(d) removing an unemitted value is free PRE-v1 and breaking
 * after it, so it is removed here rather than frozen. (The distinct
 * `"archive-entry-binary"` REFUSAL code above is a different vocabulary and is
 * untouched: that one is emitted, and it is how a binary member is actually
 * reported.)
 */
export interface ReadFileArchiveEntry {
  member: string;
  /** Display identifier only; ArchiveSelector is the canonical input form. */
  virtual_path: string;
  kind: "text" | "unknown";
  size: number;
  last_modified: number;
  handle: string;
}

/**
 * @deprecated legacy pre-v1 — removed with emitter migration (P2). Superseded
 * by `ReadArtifactResult` + `ArtifactContent.form: "archive"` (A.5.5). Its
 * top-level `kind: "archive"` is a DIRECT COLLISION with the v1 discriminator
 * and is renamed to `content.form` by A.9.2 row 7; `truncated` becomes `limit`
 * (Rule T).
 */
export interface ReadFileArchiveOutput {
  mode: "archive";
  kind: "archive";
  format: ArchiveFormat;
  path: string;
  handle: string;
  sha: string;
  entries: ReadFileArchiveEntry[];
  total_entries: number;
  total_uncompressed_bytes: number;
  truncated: boolean;
  warnings: string[];
  read_only: true;
}

export interface ArchiveMemberProvenance {
  path: string;
  member: string;
  format: ArchiveFormat;
  archive_sha?: string;
  read_only: true;
}
