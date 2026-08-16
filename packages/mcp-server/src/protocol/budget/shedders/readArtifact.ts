// ---------------------------------------------------------------------------
// protocol v1 — the `read.artifact` shed ladder (P3a S3).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §5.3, §5.7;
// DESIGN-v0.10-protocol-v1-contract-freeze.md A.5.5 (`ArtifactContent`, seven
// arms), A.6.2, A.8.1 E-7; erratum E1 (rung 6).
//
// LADDER: 1 (prose inside `content`) -> 6 (drop one trailing per-source record,
// FLOOR ONE, `next` = the artifact read that returns exactly it).
//
// ------------------- THE FLOOR, RESTATED IN THE MEMBER'S OWN TERMS ----------
//
// §5.3 phrases this member's floor as ">=1 content-bearing `artifact_sections`
// entry per source". `artifact_sections` IS NOT THIS MEMBER'S FIELD —
// A.5.5 says so itself ("the flattened `content` above is what `mode=artifact`
// actually emits, and the two are different responses"); it belongs to the
// task pack's `plan` (A.6.1). Restated per form, which is what the floor
// actually means here:
//
//   form            record array   floor   selector the recovery names
//   xlsx.roster     sheets[]         1     `sheet` = the entry's own `name`
//   docx            sections[]       1     `sections:[heading]`
//   pdf             pages[]          1     `pages:[String(page)]`
//   archive         entries[]        1     `archive:{path, member}`
//   pptx            slides[]         -     NO SELECTOR -> declines (below)
//   xlsx.table,csv  rows[][]         -     NO SELECTOR -> declines (below)
//   docx|xlsx|pptx|pdf + `text`      -     one blob, no records at all
//
// WHY THE THREE DECLINES ARE DECLINES AND NOT FLOORS (E5). A rung-6 step must
// name an executable `next` or return `undefined`:
//
//   `pptx.slides[]` entries are `{heading, text}` — no slide number. The
//       request's `slides` argument is a selector list, and a HEADING is not a
//       selector; deriving one from the array index would be right only if this
//       array were provably the whole deck, which a response that may already
//       have been cut upstream cannot promise.
//   `csv` / `xlsx.table` `rows` are `unknown[][]` — bare cell arrays with no
//       row identity on the wire. `range` names the window in A1 notation and
//       reconstructing a narrower one is arithmetic on a spelling this module
//       does not own. `total_rows` keeps telling the truth either way, so the
//       loss from declining is bytes, not honesty.
//
// Both are reported as S3 open items rather than closed silently.
// ---------------------------------------------------------------------------

import type { ToolCall } from "@tokenlighten/types";

import { emittableToolCall } from "../../refusal.js";
import {
  arrayAt,
  dropInBlock,
  dropTrailingEntry,
  isRecord,
  recordAt,
  str,
  withKey,
  type ShedOutcome,
  type ShedPayload,
  type Shedder,
} from "./registry.js";

/**
 * Prose inside `content`. `csv`'s `note` is the only E-7 token this member
 * declares (A.5.5 marks it "Prose; A.8 rule E-7" outright); the roster's
 * `inlined.note` is the same field one level down and is swept with it.
 */
function shedArtifactProse(payload: ShedPayload): ShedOutcome | undefined {
  const direct = dropInBlock(payload, "content", ["note"], 1);
  if (direct !== undefined) return direct;

  const content = recordAt(payload, "content");
  if (content === undefined) return undefined;
  const inlined = recordAt(content, "inlined");
  if (inlined === undefined || inlined["note"] === undefined) return undefined;
  const { note: _dropped, ...rest } = inlined;
  return {
    next: withKey(payload, "content", withKey(content, "inlined", rest)),
    note: { rung: 1, refs: ["content.inlined.note"] },
  };
}

/** The per-form record array, for the four forms whose entries carry a selector. */
const RECORD_ARRAY: Readonly<Record<string, string>> = {
  "xlsx.roster": "sheets",
  docx: "sections",
  pdf: "pages",
  archive: "entries",
};

function shedArtifactRecord(payload: ShedPayload): ShedOutcome | undefined {
  const content = recordAt(payload, "content");
  if (content === undefined) return undefined;
  const form = str(content["form"]);
  if (form === undefined) return undefined;
  const key = RECORD_ARRAY[form];
  if (key === undefined) return undefined;

  const entries = arrayAt(content, key);
  if (entries === undefined) return undefined;
  const trimmed = dropTrailingEntry(entries, 1);
  if (trimmed === undefined) return undefined;
  if (!isRecord(trimmed.dropped)) return undefined;

  const path = str(payload["path"]);
  if (path === undefined) return undefined;
  const named = selectorFor(form, trimmed.dropped, path);
  if (named === undefined) return undefined;

  return {
    next: withKey(payload, "content", withKey(content, key, trimmed.next)),
    note: { rung: 6, refs: [named.ref] },
    continuation: named.call,
  };
}

/**
 * The artifact read that returns EXACTLY the dropped record.
 *
 * Every arm addresses by the entry's OWN identity — the sheet's `name`, the
 * section's `heading`, the page's `page` number, the archive member's `member`
 * — so the recovery is exact rather than a re-read of the whole source. Built
 * through `emittableToolCall`, so the server's own inbound request-shape
 * validator is the last gate: a selector this server would refuse never ships
 * as a `next`, and the step declines instead.
 */
function selectorFor(
  form: string,
  dropped: Record<string, unknown>,
  path: string,
): { ref: string; call: ToolCall } | undefined {
  const build = (args: Record<string, unknown>, ref: string): { ref: string; call: ToolCall } | undefined => {
    const call = emittableToolCall({ tool: "read_file", arguments: { mode: "artifact", path, ...args } });
    return call === undefined ? undefined : { ref, call };
  };

  if (form === "xlsx.roster") {
    const name = str(dropped["name"]);
    return name === undefined ? undefined : build({ sheet: name }, `sheet:${name}`);
  }
  if (form === "docx") {
    const heading = str(dropped["heading"]);
    return heading === undefined ? undefined : build({ sections: [heading] }, `section:${heading}`);
  }
  if (form === "pdf") {
    const page = dropped["page"];
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return undefined;
    return build({ pages: [String(page)] }, `page:${page}`);
  }
  if (form === "archive") {
    const member = str(dropped["member"]);
    if (member === undefined) return undefined;
    const call = emittableToolCall({
      tool: "read_file",
      arguments: { mode: "archive", archive: { path, member } },
    });
    return call === undefined ? undefined : { ref: `member:${member}`, call };
  }
  return undefined;
}

export const READ_ARTIFACT_SHEDDER: Shedder = {
  kind: "read.artifact",
  rungs: [
    { rung: 1, step: shedArtifactProse },
    { rung: 6, step: shedArtifactRecord },
  ],
  refusalConvertible: true,
};
