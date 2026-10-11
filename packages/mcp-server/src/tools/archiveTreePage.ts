/**
 * archiveTreePage.ts — ATP (2026-10-10): the archive-scoped `search.tree`,
 * paged with the workspace tree's TPB machinery (`tools/exploreTree.ts`).
 *
 * THE MEASURED DEFECT (develop 937f6cc4, a 300-member zip of
 * `pkg/dirNN/file_NNN.txt`). `tl_search_files {action:"tree",
 * scope:{archive:{path}}}` (and `scope:{path:"bundle.zip"}`) answered a fixed
 * 4,968 B page of the first 200 members with `limit:{cause:"capped"}` and no
 * `next`, so members 201-300 were unreachable; `budget.bytes:60000` answered the
 * same page; `budget.bytes:2000|4000` was refused `cap-exceeded` — the wire
 * ladder's tree rung names a shallower tree and the archive tree has no
 * `depth`, so it could not shed below the budget.
 *
 * ROOT CAUSE. `tools/archive.ts`'s `archiveTree` joined `buildArchiveManifest`'s
 * `ARCHIVE_LIMITS.maxManifestEntries` (200) slice into the `tree` text and
 * passed its `truncated` flag through, which `projectTree`
 * (protocol/searchFamily.ts) can only fold into `capped`: nothing named the
 * rest of the listing, and nothing sized the page to a declared budget.
 *
 * THE FIX — the TPB pager over the WHOLE member listing (`archiveTreeListing`):
 *  - no budget: the legacy page — at most 200 members — never past the
 *    `search.tree` wire row (8 KB). A listing of at most 200 members whose
 *    whole answer fits the row is the unpaged answer, byte for byte;
 *  - `budget.bytes`/`budget.tokens`: as many whole member lines as keep the
 *    RESPONSE within the tighter of the budget and the row (`fitTreePage`,
 *    priced by `searchTreePageEnvelopeBytes`); a budget that cannot hold one
 *    line beside the envelope is refused `budget-below-minimum`, the floor
 *    named — exactly as the workspace tree refuses;
 *  - a page that stops short carries `next_call`, which `projectTree` folds
 *    into `limit:{cause:"wire",next}`: `scope.archive` (path and normalized
 *    prefix), the call's `scope.credentialRef` (the REF — the password it
 *    resolves to never rides a cursor or a continuation), the declared budget,
 *    and a cursor;
 *  - the cursor is a `continuation` handle (MAC'd, workspace-bound, expiring —
 *    `state/stateHandles.ts`) bound to the archive's path, the normalized
 *    member prefix, the archive's content digest (its sha256), a digest of the
 *    whole listing, and the member it resumes at. Presented with another
 *    archive path or prefix it is refused `invalid-input` naming the field,
 *    BEFORE the archive is read, so a cursor never widens or moves a scope; a
 *    forged, expired or foreign cursor is `cursor-invalid` and a changed
 *    archive (or listing) `cursor-stale`, both with the restart call as `next`;
 *  - no truncation marker: every line is a member path a caller may hand back
 *    as `archive.member`, and `limit` alone says the page stopped short.
 */

import * as path from "node:path";
import type { ArchiveFormat, JsonValue, ToolCall } from "@tokenlighten/types";

import { ARCHIVE_LIMITS, normalizeArchivePrefix, type ArchiveTreeListing } from "./archive.js";
import {
  declaredTreePageBytes,
  digest16,
  fitTreePage,
  searchTreePageBytes,
  searchTreePageEnvelopeBytes,
  treeBudgetArguments,
  type TreeBudget,
} from "./exploreTree.js";
import { mintContinuationHandle, resolveContinuationHandle } from "../state/stateHandles.js";
import { budgetFor } from "../protocol/budget/wireBudget.js";

/** One archive-scoped `tl_search_files action:"tree"` call, as `server.ts`'s dispatcher resolved it. */
export interface ArchiveTreeRequest {
  /** The archive's outer path as the call named it. */
  outerPath: string;
  /** The member prefix the call named (`archive.prefix`, `archive.member`, a virtual path's member), unnormalized. */
  prefix?: string;
  /** The `cursor` this call presented — a resume of an earlier page. */
  cursor?: string;
  /** The caller's declared `budget.bytes`/`budget.tokens`. */
  budget: TreeBudget;
  /** The call's `scope.credentialRef`, echoed on every continuation (never the password). */
  credentialRef?: string;
  /** What the envelope adds to an emitted continuation (`cwd`, `lane`, `task.handle`) — priced into the page. */
  echo: { cwd: string; lane?: string; taskHandle?: string };
  /** The request fields that named the archive path and the prefix, for a scope-change refusal's `field`. */
  fields: { path: string; prefix: string };
}

/** What an archive tree cursor's authenticated (not encrypted) tail carries — digests and a position, no path, no credential. */
export interface ArchiveTreeCursorPayload {
  v: 1;
  t: "archive-tree";
  /** Digest of the archive's workspace-relative path. */
  p: string;
  /** Digest of the normalized member prefix ("" for the whole archive). */
  x: string;
  /** The archive's content digest: the first 16 hex digits of its sha256. */
  a: string;
  /** Digest of the whole member listing. */
  s: string;
  /** The first listing line (member) the next page serves. */
  o: number;
}

/** The body `server.ts` hands `toolOk` — `projectTree` nests `total_entries`/`format`/`warnings` under `archive`. */
export interface ArchiveTreeBody {
  root: string;
  tree: string;
  truncated: boolean;
  total_entries: number;
  format: ArchiveFormat;
  warnings: string[];
  /** Present only on a page that stops short: the call that serves the rest of the SAME listing. */
  next_call?: ToolCall;
}

export type ArchiveTreeAdmission =
  | { ok: true; resume?: ArchiveTreeCursorPayload }
  | { ok: false; refusal: Record<string, unknown> };

export type ArchiveTreeResponse =
  | { kind: "body"; body: ArchiveTreeBody }
  | { kind: "refusal"; refusal: Record<string, unknown> };

/** The archive path as a cursor binds it: workspace-relative and POSIX, so `a.zip`, `./a.zip` and its absolute spelling are one archive. */
function archivePathDigest(workspace: string, outerPath: string): string {
  const root = path.resolve(workspace);
  const relative = path.relative(root, path.resolve(root, outerPath)).split(path.sep).join("/");
  return digest16(`archive-tree-path\u0000${relative}`);
}

function archivePrefixDigest(normalizedPrefix: string): string {
  return digest16(`archive-tree-prefix\u0000${normalizedPrefix}`);
}

/** `sha256:<hex>` -> its first 16 hex digits. */
function archiveContentDigest(sha: string): string {
  return (sha.startsWith("sha256:") ? sha.slice("sha256:".length) : sha).slice(0, 16);
}

function readArchiveTreeCursorPayload(value: unknown): ArchiveTreeCursorPayload | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  if (p["v"] !== 1 || p["t"] !== "archive-tree") return undefined;
  if (typeof p["p"] !== "string" || typeof p["x"] !== "string" || typeof p["a"] !== "string" || typeof p["s"] !== "string") {
    return undefined;
  }
  if (typeof p["o"] !== "number" || !Number.isInteger(p["o"]) || p["o"] < 1) return undefined;
  return { v: 1, t: "archive-tree", p: p["p"], x: p["x"], a: p["a"], s: p["s"], o: p["o"] };
}

/** The canonical archive tree call for this request's archive and `normalizedPrefix` — a continuation adds `cursor`. */
function archiveTreeCallArguments(request: ArchiveTreeRequest, normalizedPrefix: string): Record<string, JsonValue> {
  const budget = treeBudgetArguments(request.budget);
  return {
    action: "tree",
    scope: {
      archive: { path: request.outerPath, ...(normalizedPrefix !== "" ? { prefix: normalizedPrefix } : {}) },
      ...(request.credentialRef !== undefined ? { credentialRef: request.credentialRef } : {}),
    },
    ...(budget !== undefined ? { budget } : {}),
  };
}

function restartCall(request: ArchiveTreeRequest, normalizedPrefix: string): ToolCall {
  return { tool: "tl_search_files", arguments: archiveTreeCallArguments(request, normalizedPrefix) };
}

/**
 * Phase 1, BEFORE the archive is read: authenticate a presented cursor and
 * check it names this call's archive path and member prefix. A call with no
 * cursor is admitted as a first page.
 */
export function admitArchiveTreeCursor(workspace: string, request: ArchiveTreeRequest): ArchiveTreeAdmission {
  if (request.cursor === undefined) return { ok: true };
  const normalizedPrefix = normalizeArchivePrefix(request.prefix) ?? "";
  const resolved = resolveContinuationHandle<unknown>(request.cursor, workspace);
  const resume = resolved.ok ? readArchiveTreeCursorPayload(resolved.payload) : undefined;
  if (resume === undefined) {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "cursor-invalid",
        field: "cursor",
        error: "this archive tree cursor is not usable here",
        detail: `${resolved.ok ? "wrong-purpose" : resolved.outcome}; re-issue the original tree call`,
        retry: "call",
        next: restartCall(request, normalizedPrefix),
      },
    };
  }
  const changed = resume.p !== archivePathDigest(workspace, request.outerPath)
    ? request.fields.path
    : resume.x !== archivePrefixDigest(normalizedPrefix)
      ? request.fields.prefix
      : undefined;
  if (changed !== undefined) {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "invalid-input",
        field: changed,
        error: `archive tree cursor continuation cannot change '${changed}'`,
        detail: "a tree cursor continuation accepts only budget overrides; re-issue the original tree call to list another archive or prefix",
        retry: "call",
      },
    };
  }
  return { ok: true, resume };
}

/**
 * Phase 2: serve one page of `listing` — a first page, or the page an admitted
 * cursor (`resume`) names. See the module header for the paging rules.
 */
export function buildArchiveTreePage(
  workspace: string,
  request: ArchiveTreeRequest,
  listing: ArchiveTreeListing,
  resume?: ArchiveTreeCursorPayload,
): ArchiveTreeResponse {
  const lines = listing.members;
  const contentDigest = archiveContentDigest(listing.sha);
  const listingDigest = digest16(lines.join("\n"));
  const cursorAt = (offset: number): string | undefined => {
    const payload: ArchiveTreeCursorPayload = {
      v: 1,
      t: "archive-tree",
      p: archivePathDigest(workspace, request.outerPath),
      x: archivePrefixDigest(listing.prefix),
      a: contentDigest,
      s: listingDigest,
      o: offset,
    };
    return mintContinuationHandle(workspace, payload);
  };

  let offset = 0;
  if (resume !== undefined) {
    if (resume.a !== contentDigest || resume.s !== listingDigest || resume.o >= lines.length) {
      return {
        kind: "refusal",
        refusal: {
          ok: false,
          code: "cursor-stale",
          field: "cursor",
          error: "the archive under this tree cursor changed",
          detail: "pages of one archive listing are never mixed across a changed archive; restart the original tree call",
          retry: "call",
          next: restartCall(request, listing.prefix),
        },
      };
    }
    offset = resume.o;
  }

  // The page's wire members besides `tree` — what `projectTree` will emit.
  const fields = {
    root: listing.root,
    archive: { format: listing.format, total_entries: lines.length, warnings: listing.warnings },
  };
  const page = (end: number, truncated: boolean): ArchiveTreeBody => ({
    root: listing.root,
    tree: lines.slice(offset, end).join("\n"),
    truncated,
    total_entries: lines.length,
    format: listing.format,
    warnings: listing.warnings,
  });

  const declared = declaredTreePageBytes(request.budget);
  const row = budgetFor("search.tree");
  // No budget, and the whole listing is the legacy page: the unpaged answer,
  // byte for byte, whenever that answer fits the row (measured exactly, with
  // no margin, so nothing that used to be served whole is now split). One
  // that does not fit used to be refused `cap-exceeded`; it pages below.
  if (
    declared === undefined
    && offset === 0
    && lines.length <= ARCHIVE_LIMITS.maxManifestEntries
    && searchTreePageBytes(fields, lines.join("\n")) <= row
  ) {
    return { kind: "body", body: page(lines.length, false) };
  }

  const limit = declared === undefined ? row : Math.min(declared, row);
  const continuationArguments = (cursor: string): Record<string, JsonValue> => ({
    ...archiveTreeCallArguments(request, listing.prefix),
    cursor,
  });
  // A placeholder cursor at the largest offset this listing can name, so the
  // measured continuation is never shorter than the real one.
  const placeholderCursor = cursorAt(lines.length) ?? "";
  const completeEnvelope = searchTreePageEnvelopeBytes(fields);
  const truncatedEnvelope = searchTreePageEnvelopeBytes(fields, {
    cwd: request.echo.cwd,
    ...(request.echo.lane !== undefined && request.echo.lane !== "" ? { lane: request.echo.lane } : {}),
    ...(request.echo.taskHandle !== undefined ? { task: { handle: request.echo.taskHandle } } : {}),
    ...continuationArguments(placeholderCursor),
  });
  const fit = fitTreePage(lines, offset, limit - completeEnvelope, limit - truncatedEnvelope, {
    markerBytes: 0,
    ...(declared === undefined ? { maxLines: ARCHIVE_LIMITS.maxManifestEntries } : {}),
  });

  let end: number;
  let truncated: boolean;
  if (fit.ok) {
    ({ end, truncated } = fit);
  } else if (declared === undefined) {
    // One member path longer than the whole row beside its envelope: there is
    // no budget to name a floor against, so it ships alone and the funnel's
    // row check answers it, as it answered the unpaged listing.
    end = offset + 1;
    truncated = end < lines.length;
  } else {
    return {
      kind: "refusal",
      refusal: {
        ok: false,
        code: "budget-below-minimum",
        field: "budget",
        error: `budget ${limit} B cannot hold one whole archive member line plus its envelope`,
        detail: "raise budget.bytes to at least required_min_bytes (enough for every remaining page of this listing) and re-issue this tree call",
        required_min_bytes: truncatedEnvelope + fit.requiredTextBytes,
        retry: "call",
      },
    };
  }

  const body = page(end, truncated);
  if (truncated) {
    const cursor = cursorAt(end);
    if (cursor !== undefined) body.next_call = { tool: "tl_search_files", arguments: continuationArguments(cursor) };
  }
  return { kind: "body", body };
}
