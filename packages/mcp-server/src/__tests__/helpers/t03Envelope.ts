/**
 * t03Envelope.ts — a reply with what each server mints set aside, for comparing
 * the three replies of the T03 whole-body chain with the r18 recording
 * (fixtures/t03-whole-chain.json, `envelopes`).
 *
 * The envelope is everything but `evidence`: the decision (its `next` cursors,
 * its `gaps`, its certificate), `limit`, `answer_resolution`, `profile_binding`,
 * `task`, `qref`. Set aside: the build stamp, task ids, replay refs, cursor
 * aliases, evidence handles, certificate ids and content hashes — all minted per
 * session or per build — and the number of candidate files a certificate gap
 * names (the recording's workspace holds one file fewer than a cell built from the
 * fixture). Everything else must be the recording's.
 */

/** The reply's envelope, normalized: `evidence` dropped, minted values replaced by placeholders. */
export function normalizeEnvelope(reply: unknown, workspace?: string): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(reply)) as Record<string, unknown>;
  delete copy["evidence"];
  if (typeof copy["server_build"] === "string") copy["server_build"] = "<BUILD>";
  let text = JSON.stringify(copy);
  if (workspace !== undefined && workspace !== "") text = text.split(JSON.stringify(workspace).slice(1, -1)).join("<WS>");
  text = text
    .replace(/tlh_[A-Za-z0-9_-]+/gu, "<TASK>")
    .replace(/\bq-[0-9a-f]{16}\b/gu, "<QREF>")
    .replace(/tlc_s1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{22}/gu, "<CURSOR>")
    .replace(/"h[0-9a-z]{10}"/gu, "\"<H>\"")
    .replace(/ready-[0-9a-f]{8,}(?:-[0-9a-f]{8,})?/gu, "ready-<ID>")
    .replace(/sha256:[0-9a-f]{64}/gu, "sha256:<HEX>")
    .replace(/\b\d+ candidate files\b/gu, "<N> candidate files");
  return JSON.parse(text) as Record<string, unknown>;
}
