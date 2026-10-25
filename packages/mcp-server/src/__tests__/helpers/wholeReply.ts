// 2026-10-23, codex-copilot-proxy wire compaction: a reply as a reader of the WHOLE envelope sees it.
//
// Two members of a task-pack reply can leave out what another member of the same reply carries:
//   - an obligation's `path` / `range` / `role` (TL_EFF_REPLY_COMPACT, default ON, protocol/wireCompaction.ts): an
//     obligation without one has the value of the first evidence row of its `handle`;
//   - an evidence row's `path` / `handle` (TL_EFF_EVIDENCE_PATH_GROUPS, default OFF, protocol/evidencePathGroups.ts): a
//     row without them is on the file and the handle of the row above, in a reply whose `evidence_note` says so.
// A spec whose subject is neither reads the reply through `wholeReply`, so it asserts what the reply MEANS and stays
// correct under either flag; a spec whose subject is the shipped shape reads the text it was handed.
import { expandEvidencePathGroups } from "../../protocol/evidencePathGroups.js";
import { resolveObligations } from "../../protocol/wireCompaction.js";

type Body = Record<string, unknown>;

const record = (value: unknown): Body | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Body : undefined;

/** `body` with grouped evidence rows resolved and compacted obligations restored; the argument is not mutated. */
export function wholeReply<T extends Body>(body: T): T {
  const expanded = expandEvidencePathGroups(body);
  const plan = record(expanded["plan"]);
  const contract = record(plan?.["change_contract"]);
  const obligations = contract?.["obligations"];
  if (plan === undefined || contract === undefined || !Array.isArray(obligations) || !Array.isArray(expanded["evidence"])) return expanded as T;
  return {
    ...expanded,
    plan: { ...plan, change_contract: { ...contract, obligations: resolveObligations(obligations, expanded["evidence"]) } },
  } as unknown as T;
}

/** `JSON.parse(text)` read through `wholeReply`; `undefined` for text that is not one JSON object. */
export function parseWholeReply(text: string): Body | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return record(parsed) === undefined ? undefined : wholeReply(parsed as Body);
  } catch {
    return undefined;
  }
}
